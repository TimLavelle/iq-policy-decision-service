#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# setup-aws-kb.sh
# Provisions the AWS infrastructure for the Qantas iQ Single View of Policy (SVoP)
# Bedrock Knowledge Base.
#
# What it creates (idempotent — skips existing resources):
#   1. S3 bucket with versioning for policy documents
#   2. OpenSearch Serverless security policies, collection, and data access policy
#   3. IAM role iq-svop-bedrock-role with least-privilege inline policy
#   4. Bedrock Knowledge Base (Titan Embed Text v2 → OpenSearch Serverless)
#   5. S3 data source linked to the KB
#   6. Writes BEDROCK_KB_ID, BEDROCK_KB_DATA_SOURCE_ID, POLICY_DOCUMENTS_BUCKET
#      to iq-policy-decision-service/.env
#
# Prerequisites:
#   - awscli v2 installed and configured (aws configure)
#   - Permissions: s3:*, iam:*, bedrock-agent:*, aoss:*
#
# Usage:
#   chmod +x scripts/setup-aws-kb.sh
#   ./scripts/setup-aws-kb.sh
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

REGION="${AWS_REGION:-ap-southeast-2}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
ENV_FILE="${REPO_DIR}/.env"

echo "==> iQ SVoP Bedrock Knowledge Base setup"
echo "    Region : ${REGION}"
echo "    Env    : ${ENV_FILE}"
echo ""

# ─── Helpers ──────────────────────────────────────────────────────────────────

info()    { echo "[INFO]  $*"; }
success() { echo "[OK]    $*"; }
warn()    { echo "[WARN]  $*"; }

# Append or update a KEY=value line in the .env file (idempotent)
write_env() {
  local key="$1"
  local value="$2"
  touch "${ENV_FILE}"
  if grep -q "^${key}=" "${ENV_FILE}" 2>/dev/null; then
    # Update existing line (macOS-compatible sed)
    sed -i '' "s|^${key}=.*|${key}=${value}|" "${ENV_FILE}"
    info "Updated ${key} in ${ENV_FILE}"
  else
    echo "${key}=${value}" >> "${ENV_FILE}"
    info "Wrote ${key} to ${ENV_FILE}"
  fi
}

# ─── 1. Resolve AWS Account ID + Caller Identity ─────────────────────────────

info "Resolving AWS account ID..."
ACCOUNT_ID="$(aws sts get-caller-identity --query Account --output text)"
CALLER_ARN="$(aws sts get-caller-identity --query Arn --output text)"
success "Account: ${ACCOUNT_ID}"
success "Caller : ${CALLER_ARN}"

BUCKET_NAME="iq-policy-documents-${ACCOUNT_ID}"
COLLECTION_NAME="iq-svop-collection"
KB_NAME="iq-policy-knowledge-base"
ROLE_NAME="iq-svop-bedrock-role"
EMBED_MODEL_ARN="arn:aws:bedrock:${REGION}::foundation-model/amazon.titan-embed-text-v2:0"

# ─── 2. S3 Bucket ─────────────────────────────────────────────────────────────

info "Checking S3 bucket: ${BUCKET_NAME}..."
if aws s3api head-bucket --bucket "${BUCKET_NAME}" 2>/dev/null; then
  success "S3 bucket already exists: ${BUCKET_NAME}"
else
  info "Creating S3 bucket ${BUCKET_NAME} in ${REGION}..."
  if [ "${REGION}" = "us-east-1" ]; then
    aws s3api create-bucket --bucket "${BUCKET_NAME}" --region "${REGION}"
  else
    aws s3api create-bucket \
      --bucket "${BUCKET_NAME}" \
      --region "${REGION}" \
      --create-bucket-configuration LocationConstraint="${REGION}"
  fi
  success "S3 bucket created: ${BUCKET_NAME}"
fi

info "Enabling versioning on S3 bucket..."
aws s3api put-bucket-versioning \
  --bucket "${BUCKET_NAME}" \
  --versioning-configuration Status=Enabled
success "Versioning enabled"

# Block all public access
aws s3api put-public-access-block \
  --bucket "${BUCKET_NAME}" \
  --public-access-block-configuration \
    BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true
success "Public access blocked on bucket"

write_env "POLICY_DOCUMENTS_BUCKET" "${BUCKET_NAME}"

# ─── 3. IAM Role ──────────────────────────────────────────────────────────────

TRUST_POLICY='{
  "Version": "2012-10-17",
  "Statement": [{
    "Effect": "Allow",
    "Principal": { "Service": "bedrock.amazonaws.com" },
    "Action": "sts:AssumeRole",
    "Condition": {
      "StringEquals": { "aws:SourceAccount": "'"${ACCOUNT_ID}"'" },
      "ArnLike": { "aws:SourceArn": "arn:aws:bedrock:'"${REGION}"':'"${ACCOUNT_ID}"':knowledge-base/*" }
    }
  }]
}'

info "Checking IAM role: ${ROLE_NAME}..."
if ROLE_ARN="$(aws iam get-role --role-name "${ROLE_NAME}" --query 'Role.Arn' --output text 2>/dev/null)"; then
  success "IAM role already exists: ${ROLE_ARN}"
else
  info "Creating IAM role: ${ROLE_NAME}..."
  ROLE_ARN="$(aws iam create-role \
    --role-name "${ROLE_NAME}" \
    --assume-role-policy-document "${TRUST_POLICY}" \
    --description "Bedrock Knowledge Base role for iQ SVoP policy documents" \
    --query 'Role.Arn' \
    --output text)"
  success "Created IAM role: ${ROLE_ARN}"
fi

INLINE_POLICY='{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "BedrockFoundationModel",
      "Effect": "Allow",
      "Action": [
        "bedrock:InvokeModel",
        "bedrock:InvokeModelWithResponseStream"
      ],
      "Resource": "arn:aws:bedrock:'"${REGION}"'::foundation-model/*"
    },
    {
      "Sid": "OpenSearchServerless",
      "Effect": "Allow",
      "Action": "aoss:APIAccessAll",
      "Resource": "arn:aws:aoss:'"${REGION}"':'"${ACCOUNT_ID}"':collection/*"
    },
    {
      "Sid": "S3PolicyDocuments",
      "Effect": "Allow",
      "Action": [
        "s3:GetObject",
        "s3:ListBucket"
      ],
      "Resource": [
        "arn:aws:s3:::'"${BUCKET_NAME}"'",
        "arn:aws:s3:::'"${BUCKET_NAME}"'/*"
      ]
    }
  ]
}'

info "Attaching inline policy to role ${ROLE_NAME}..."
aws iam put-role-policy \
  --role-name "${ROLE_NAME}" \
  --policy-name "iq-svop-bedrock-policy" \
  --policy-document "${INLINE_POLICY}"
success "Inline policy attached"

# ─── 4. OpenSearch Serverless Collection ──────────────────────────────────────
# Bedrock Knowledge Base requires AOSS as the vector store.
# Steps: encryption policy → network policy → collection → data access policy

info "Checking OpenSearch Serverless collection: ${COLLECTION_NAME}..."
COLLECTION_ID="$(aws opensearchserverless list-collections \
  --query "collectionSummaries[?name=='${COLLECTION_NAME}'].id | [0]" \
  --output text 2>/dev/null || echo 'None')"

if [ "${COLLECTION_ID}" = "None" ] || [ -z "${COLLECTION_ID}" ]; then
  info "Creating AOSS encryption policy..."
  aws opensearchserverless create-security-policy \
    --name "${COLLECTION_NAME}-enc" \
    --type encryption \
    --policy '{
      "Rules": [{"ResourceType":"collection","Resource":["collection/'"${COLLECTION_NAME}"'"]}],
      "AWSOwnedKey": true
    }' 2>/dev/null || warn "Encryption policy may already exist — continuing"

  info "Creating AOSS network policy..."
  aws opensearchserverless create-security-policy \
    --name "${COLLECTION_NAME}-net" \
    --type network \
    --policy '[{
      "Rules": [
        {"ResourceType":"collection","Resource":["collection/'"${COLLECTION_NAME}"'"]},
        {"ResourceType":"dashboard","Resource":["collection/'"${COLLECTION_NAME}"'"]}
      ],
      "AllowFromPublic": true
    }]' 2>/dev/null || warn "Network policy may already exist — continuing"

  info "Creating AOSS collection (this takes 3-5 minutes)..."
  COLLECTION_ID="$(aws opensearchserverless create-collection \
    --name "${COLLECTION_NAME}" \
    --type VECTORSEARCH \
    --description "iQ SVoP policy document vector store" \
    --query 'createCollectionDetail.id' \
    --output text)"
  success "Collection creation initiated: id=${COLLECTION_ID}"

  info "Waiting for collection to become ACTIVE..."
  while true; do
    STATUS="$(aws opensearchserverless batch-get-collection \
      --ids "${COLLECTION_ID}" \
      --query 'collectionDetails[0].status' \
      --output text)"
    echo "    status: ${STATUS}"
    [ "${STATUS}" = "ACTIVE" ] && break
    sleep 20
  done
  success "Collection ACTIVE: ${COLLECTION_ID}"
else
  success "Collection already exists: ${COLLECTION_ID}"
fi

COLLECTION_ENDPOINT="$(aws opensearchserverless batch-get-collection \
  --ids "${COLLECTION_ID}" \
  --query 'collectionDetails[0].collectionEndpoint' \
  --output text)"
COLLECTION_ARN="arn:aws:aoss:${REGION}:${ACCOUNT_ID}:collection/${COLLECTION_ID}"
success "Collection endpoint: ${COLLECTION_ENDPOINT}"

info "Waiting for collection to be fully initialized..."
sleep 60

# ─── Data access policy MUST exist before index creation ──────────────────────
# Grants access to:
#   - ${ROLE_ARN}   : Bedrock KB role (reads/writes index during ingestion + retrieval)
#   - ${CALLER_ARN} : Your IAM identity (runs create-index.py below)

DATA_ACCESS_POLICY='[{
  "Rules": [
    {
      "ResourceType": "collection",
      "Resource": ["collection/'"${COLLECTION_NAME}"'"],
      "Permission": [
        "aoss:CreateCollectionItems",
        "aoss:DeleteCollectionItems",
        "aoss:UpdateCollectionItems",
        "aoss:DescribeCollectionItems"
      ]
    },
    {
      "ResourceType": "index",
      "Resource": ["index/'"${COLLECTION_NAME}"'/*"],
      "Permission": [
        "aoss:CreateIndex",
        "aoss:DeleteIndex",
        "aoss:UpdateIndex",
        "aoss:DescribeIndex",
        "aoss:ReadDocument",
        "aoss:WriteDocument"
      ]
    }
  ],
  "Principal": ["'"${ROLE_ARN}"'", "'"${CALLER_ARN}"'"]
}]'

info "Creating/updating AOSS data access policy..."
if EXISTING_VERSION="$(aws opensearchserverless get-access-policy \
    --name "${COLLECTION_NAME}-access" \
    --type data \
    --query 'accessPolicyDetail.policyVersion' \
    --output text 2>/dev/null)"; then
  info "Policy exists (version ${EXISTING_VERSION}) — updating..."
  UPDATE_OUT="$(aws opensearchserverless update-access-policy \
    --name "${COLLECTION_NAME}-access" \
    --type data \
    --policy-version "${EXISTING_VERSION}" \
    --policy "${DATA_ACCESS_POLICY}" 2>&1)" || {
    if echo "${UPDATE_OUT}" | grep -q "No changes detected"; then
      warn "Policy unchanged — already up to date"
    else
      echo "${UPDATE_OUT}" >&2
      exit 1
    fi
  }
  success "Data access policy updated"
else
  aws opensearchserverless create-access-policy \
    --name "${COLLECTION_NAME}-access" \
    --type data \
    --policy "${DATA_ACCESS_POLICY}"
  success "Data access policy created"
fi

# Give IAM time to propagate before hitting the AOSS endpoint
info "Waiting 15s for access policy to propagate..."
sleep 15

info "Creating OpenSearch index for Knowledge Base..."
python3 "${SCRIPT_DIR}/create-index.py" "${COLLECTION_ENDPOINT}" "iq-policy-index" "${REGION}"
success "OpenSearch index ready"

# AOSS index propagation — Bedrock validates against the endpoint during KB creation.
# Without this wait, CreateKnowledgeBase returns "no such index" even though the index exists.
info "Waiting 30s for index to propagate before creating Knowledge Base..."
sleep 30

# ─── 5. Bedrock Knowledge Base ────────────────────────────────────────────────

info "Checking for existing Bedrock Knowledge Base: ${KB_NAME}..."
KB_ID="$(aws bedrock-agent list-knowledge-bases \
  --query "knowledgeBaseSummaries[?name=='${KB_NAME}'].knowledgeBaseId | [0]" \
  --output text 2>/dev/null || echo 'None')"

if [ "${KB_ID}" = "None" ] || [ -z "${KB_ID}" ]; then
  info "Creating Bedrock Knowledge Base: ${KB_NAME}..."
  KB_JSON="$(aws bedrock-agent create-knowledge-base \
    --name "${KB_NAME}" \
    --description "iQ Single View of Policy — 180 Qantas policy documents, RAG-enabled" \
    --role-arn "${ROLE_ARN}" \
    --knowledge-base-configuration '{
      "type": "VECTOR",
      "vectorKnowledgeBaseConfiguration": {
        "embeddingModelArn": "'"${EMBED_MODEL_ARN}"'"
      }
    }' \
    --storage-configuration '{
      "type": "OPENSEARCH_SERVERLESS",
      "opensearchServerlessConfiguration": {
        "collectionArn": "'"${COLLECTION_ARN}"'",
        "vectorIndexName": "iq-policy-index",
        "fieldMapping": {
          "vectorField": "embedding",
          "textField": "content",
          "metadataField": "metadata"
        }
      }
    }')"
  KB_ID="$(echo "${KB_JSON}" | python3 -c "import sys,json; print(json.load(sys.stdin)['knowledgeBase']['knowledgeBaseId'])")"
  success "Knowledge Base created: ${KB_ID}"

  info "Waiting for KB to become ACTIVE..."
  while true; do
    KB_STATUS="$(aws bedrock-agent get-knowledge-base \
      --knowledge-base-id "${KB_ID}" \
      --query 'knowledgeBase.status' \
      --output text)"
    echo "    status: ${KB_STATUS}"
    [ "${KB_STATUS}" = "ACTIVE" ] && break
    sleep 10
  done
  success "Knowledge Base ACTIVE"
else
  success "Knowledge Base already exists: ${KB_ID}"
fi

write_env "BEDROCK_KB_ID" "${KB_ID}"

# ─── 6. S3 Data Source ────────────────────────────────────────────────────────

info "Checking for existing S3 data source on KB ${KB_ID}..."
DS_ID="$(aws bedrock-agent list-data-sources \
  --knowledge-base-id "${KB_ID}" \
  --query 'dataSourceSummaries[0].dataSourceId' \
  --output text 2>/dev/null || echo 'None')"

if [ "${DS_ID}" = "None" ] || [ -z "${DS_ID}" ]; then
  info "Creating S3 data source..."
  DS_JSON="$(aws bedrock-agent create-data-source \
    --knowledge-base-id "${KB_ID}" \
    --name "iq-policy-documents-s3" \
    --description "Qantas policy JSON documents — 180 files covering 9 policy domains" \
    --data-source-configuration '{
      "type": "S3",
      "s3Configuration": {
        "bucketArn": "arn:aws:s3:::'"${BUCKET_NAME}"'",
        "inclusionPrefixes": ["policies/"]
      }
    }' \
    --vector-ingestion-configuration '{
      "chunkingConfiguration": {
        "chunkingStrategy": "FIXED_SIZE",
        "fixedSizeChunkingConfiguration": {
          "maxTokens": 512,
          "overlapPercentage": 20
        }
      }
    }')"
  DS_ID="$(echo "${DS_JSON}" | python3 -c "import sys,json; print(json.load(sys.stdin)['dataSource']['dataSourceId'])")"
  success "Data source created: ${DS_ID}"
else
  success "Data source already exists: ${DS_ID}"
fi

write_env "BEDROCK_KB_DATA_SOURCE_ID" "${DS_ID}"

# ─── 7. Summary ───────────────────────────────────────────────────────────────

echo ""
echo "═══════════════════════════════════════════════════════════"
echo " iQ SVoP Bedrock Knowledge Base — provisioning complete"
echo "═══════════════════════════════════════════════════════════"
echo " POLICY_DOCUMENTS_BUCKET=${BUCKET_NAME}"
echo " BEDROCK_KB_ID=${KB_ID}"
echo " BEDROCK_KB_DATA_SOURCE_ID=${DS_ID}"
echo " AOSS_COLLECTION_ENDPOINT=${COLLECTION_ENDPOINT}"
echo ""
echo " Written to: ${ENV_FILE}"
echo ""
echo " Next steps:"
echo "   1. Run: node scripts/seed-policies.js"
echo "   2. Verify in AWS Console → Amazon Bedrock → Knowledge Bases"
echo "   3. Restart the policy service: npm run dev"
echo "═══════════════════════════════════════════════════════════"
