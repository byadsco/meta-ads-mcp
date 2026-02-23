#!/usr/bin/env bash
set -euo pipefail

# ─────────────────────────────────────────────────────────────
# One-time GCP setup for deploying meta-ads-mcp to Cloud Run
# via GitHub Actions with Workload Identity Federation (keyless)
#
# Prerequisites: gcloud CLI, gh CLI, authenticated to both
# Usage: bash scripts/setup-gcloud.sh
# ─────────────────────────────────────────────────────────────

GITHUB_REPO="MaxterPC/meta-ads-mcp"
SERVICE_NAME="meta-ads-mcp"
SA_NAME="github-actions-deploy"
WIF_POOL="github-actions-pool"
WIF_PROVIDER="github-actions-provider"
AR_REPO="meta-ads-mcp"

# ── Prompt for required values ──────────────────────────────

read -rp "GCP Project ID: " GCP_PROJECT_ID
read -rp "GCP Region (e.g. us-central1): " GCP_REGION

echo ""
echo "Configuration:"
echo "  Project:  ${GCP_PROJECT_ID}"
echo "  Region:   ${GCP_REGION}"
echo "  Repo:     ${GITHUB_REPO}"
echo ""
read -rp "Continue? [y/N] " confirm
[[ "${confirm}" =~ ^[Yy]$ ]] || { echo "Aborted."; exit 1; }

# ── Set project ─────────────────────────────────────────────

echo ""
echo "==> Setting active project to ${GCP_PROJECT_ID}..."
gcloud config set project "${GCP_PROJECT_ID}"

# ── Get project number (needed for WIF) ─────────────────────

PROJECT_NUMBER=$(gcloud projects describe "${GCP_PROJECT_ID}" --format="value(projectNumber)")
echo "    Project number: ${PROJECT_NUMBER}"

# ── Enable APIs ─────────────────────────────────────────────

echo ""
echo "==> Enabling required APIs..."
gcloud services enable \
  run.googleapis.com \
  artifactregistry.googleapis.com \
  iam.googleapis.com \
  iamcredentials.googleapis.com \
  cloudresourcemanager.googleapis.com

# ── Create Artifact Registry repository ─────────────────────

echo ""
echo "==> Creating Artifact Registry repository..."
if gcloud artifacts repositories describe "${AR_REPO}" \
  --location="${GCP_REGION}" --format="value(name)" 2>/dev/null; then
  echo "    Repository already exists, skipping."
else
  gcloud artifacts repositories create "${AR_REPO}" \
    --repository-format=docker \
    --location="${GCP_REGION}" \
    --description="Docker images for ${SERVICE_NAME}"
  echo "    Created."
fi

# ── Create Service Account ──────────────────────────────────

SA_EMAIL="${SA_NAME}@${GCP_PROJECT_ID}.iam.gserviceaccount.com"

echo ""
echo "==> Creating service account ${SA_EMAIL}..."
if gcloud iam service-accounts describe "${SA_EMAIL}" 2>/dev/null; then
  echo "    Service account already exists, skipping."
else
  gcloud iam service-accounts create "${SA_NAME}" \
    --display-name="GitHub Actions Deploy (${SERVICE_NAME})"
  echo "    Created."
fi

# ── Grant IAM roles to Service Account ──────────────────────

echo ""
echo "==> Granting IAM roles..."
for role in \
  roles/artifactregistry.writer \
  roles/run.developer \
  roles/iam.serviceAccountUser; do
  echo "    ${role}"
  gcloud projects add-iam-policy-binding "${GCP_PROJECT_ID}" \
    --member="serviceAccount:${SA_EMAIL}" \
    --role="${role}" \
    --condition=None \
    --quiet > /dev/null
done

# ── Create Workload Identity Federation Pool ────────────────

echo ""
echo "==> Creating WIF pool..."
if gcloud iam workload-identity-pools describe "${WIF_POOL}" \
  --location="global" --format="value(name)" 2>/dev/null; then
  echo "    Pool already exists, skipping."
else
  gcloud iam workload-identity-pools create "${WIF_POOL}" \
    --location="global" \
    --display-name="GitHub Actions Pool"
  echo "    Created."
fi

# ── Create WIF Provider ─────────────────────────────────────

echo ""
echo "==> Creating WIF provider..."
if gcloud iam workload-identity-pools providers describe "${WIF_PROVIDER}" \
  --workload-identity-pool="${WIF_POOL}" \
  --location="global" --format="value(name)" 2>/dev/null; then
  echo "    Provider already exists, skipping."
else
  gcloud iam workload-identity-pools providers create-oidc "${WIF_PROVIDER}" \
    --workload-identity-pool="${WIF_POOL}" \
    --location="global" \
    --issuer-uri="https://token.actions.githubusercontent.com" \
    --attribute-mapping="google.subject=assertion.sub,attribute.repository=assertion.repository" \
    --attribute-condition="assertion.repository=='${GITHUB_REPO}'"
  echo "    Created."
fi

# ── Bind Service Account to WIF ─────────────────────────────

WIF_MEMBER="principalSet://iam.googleapis.com/projects/${PROJECT_NUMBER}/locations/global/workloadIdentityPools/${WIF_POOL}/attribute.repository/${GITHUB_REPO}"

echo ""
echo "==> Binding service account to WIF pool..."
gcloud iam service-accounts add-iam-policy-binding "${SA_EMAIL}" \
  --role="roles/iam.workloadIdentityUser" \
  --member="${WIF_MEMBER}" \
  --quiet > /dev/null
echo "    Bound."

# ── Build full WIF provider resource name ────────────────────

WIF_PROVIDER_FULL="projects/${PROJECT_NUMBER}/locations/global/workloadIdentityPools/${WIF_POOL}/providers/${WIF_PROVIDER}"

# ── Set GitHub Actions secrets ──────────────────────────────

echo ""
echo "==> Setting GitHub Actions secrets..."
gh secret set GCP_PROJECT_ID --body "${GCP_PROJECT_ID}" --repo "${GITHUB_REPO}"
gh secret set GCP_REGION --body "${GCP_REGION}" --repo "${GITHUB_REPO}"
gh secret set GCP_WIF_PROVIDER --body "${WIF_PROVIDER_FULL}" --repo "${GITHUB_REPO}"
gh secret set GCP_SERVICE_ACCOUNT --body "${SA_EMAIL}" --repo "${GITHUB_REPO}"
echo "    All secrets set."

# ── Summary ──────────────────────────────────────────────────

echo ""
echo "============================================"
echo "  Setup complete!"
echo "============================================"
echo ""
echo "  Project:          ${GCP_PROJECT_ID}"
echo "  Region:           ${GCP_REGION}"
echo "  Service Account:  ${SA_EMAIL}"
echo "  WIF Provider:     ${WIF_PROVIDER_FULL}"
echo "  Artifact Registry: ${GCP_REGION}-docker.pkg.dev/${GCP_PROJECT_ID}/${AR_REPO}"
echo ""
echo "  GitHub secrets configured:"
echo "    - GCP_PROJECT_ID"
echo "    - GCP_REGION"
echo "    - GCP_WIF_PROVIDER"
echo "    - GCP_SERVICE_ACCOUNT"
echo ""
echo "  Next: commit and push to main to trigger deployment."
echo ""
