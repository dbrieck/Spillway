#!/usr/bin/env bash
# Tests and builds the scaler, pushes it to the module's Artifact Registry repository and rolls it onto
# the Cloud Run service. Terraform owns the service's config, env and IAM but ignores its image, so this
# is how new scaler versions ship. Needs Docker and an authenticated gcloud.
#
#   scripts/deploy-scaler.sh <project> [region]      # from the repository root
set -euo pipefail

PROJECT="${1:?usage: deploy-scaler.sh <project> [region]}"
REGION="${2:-us-central1}"
SERVICE=ci-scaler # names fixed by the Terraform module
IMAGE_REPO="${REGION}-docker.pkg.dev/${PROJECT}/ci-runners/ci-scaler"

TAG="$(git rev-parse --short=12 HEAD)"
if [ -n "$(git status --porcelain -- scaler)" ]; then TAG="${TAG}-dirty-$(date -u +%Y%m%d%H%M%S)"; fi
IMAGE="${IMAGE_REPO}:${TAG}"

# A bare `gcloud run deploy` can create a service without the module's env, secrets and identity; it
# then crashes with "Missing required env var". Refuse to deploy onto anything but the module's service.
sa="$(gcloud run services describe "${SERVICE}" --project "${PROJECT}" --region "${REGION}" \
  --format 'value(spec.template.spec.serviceAccountName)' 2>/dev/null || true)"
if [ -z "${sa}" ]; then
  echo "Cloud Run service ${SERVICE} not found in ${PROJECT}/${REGION}. Run terraform apply first." >&2
  exit 1
fi
if [[ "${sa}" != ci-scaler@* ]]; then
  echo "${SERVICE} runs as ${sa}, not the module's ci-scaler@ account, so Terraform didn't create it." >&2
  echo "Delete it (gcloud run services delete ${SERVICE} --project ${PROJECT} --region ${REGION}) and run terraform apply." >&2
  exit 1
fi

echo "==> Tests"
(cd scaler && npm ci --no-audit --no-fund && npm test)

echo "==> Build and push ${IMAGE}"
gcloud auth configure-docker "${REGION}-docker.pkg.dev" --quiet
docker build --platform linux/amd64 -t "${IMAGE}" scaler
docker push "${IMAGE}"

echo "==> Deploy"
# `services update`, not `deploy`: it can only change the existing service, never create a bare one.
gcloud run services update "${SERVICE}" --project "${PROJECT}" --region "${REGION}" --image "${IMAGE}" --quiet
echo "deployed ${IMAGE}"
