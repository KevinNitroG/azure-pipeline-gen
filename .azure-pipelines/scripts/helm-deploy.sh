#!/usr/bin/env bash
# usage: helm-deploy.sh <mode> <service> <env> <namespace> [canaryWeight]
# modes: stable | canary-deploy | canary-weight | canary-promote | canary-abort | rollback | verify
set -euo pipefail

MODE="$1"; SERVICE="$2"; ENV_NAME="$3"; NS="$4"; WEIGHT="${5:-0}"
MANIFEST="${PIPELINE_WORKSPACE}/image-manifest-${SERVICE}/${SERVICE}.json"
CHART="deploy/charts/service"
VALUES="deploy/values/${ENV_NAME}/${SERVICE}.yaml"

COMMON=()
if [[ "$MODE" != rollback && "$MODE" != canary-abort && "$MODE" != verify ]]; then
  REPO="$(jq -r .repository "$MANIFEST")"
  DIGEST="$(jq -r .digest "$MANIFEST")"
  COMMON=(
    --namespace "$NS" --create-namespace -f "$VALUES"
    --set "image.repository=${REPO}" --set "image.digest=${DIGEST}"
    --set "podAnnotations.build=${BUILD_BUILDNUMBER}"
    --set "global.environment=${ENV_NAME}"
  )
fi

case "$MODE" in
  stable)
    helm upgrade --install "$SERVICE" "$CHART" "${COMMON[@]}" \
      --set "fullnameOverride=${SERVICE}" --set canary.enabled=false --atomic --wait --timeout 10m ;;
  canary-deploy)
    helm upgrade --install "${SERVICE}-canary" "$CHART" "${COMMON[@]}" \
      --set "fullnameOverride=${SERVICE}-canary" --set "stableService=${SERVICE}" \
      --set canary.enabled=true --set canary.weight=0 --atomic --wait --timeout 10m ;;
  canary-weight)
    helm upgrade "${SERVICE}-canary" "$CHART" "${COMMON[@]}" \
      --set "fullnameOverride=${SERVICE}-canary" --set "stableService=${SERVICE}" \
      --set canary.enabled=true --set "canary.weight=${WEIGHT}" --wait --timeout 5m ;;
  canary-promote)
    helm upgrade --install "$SERVICE" "$CHART" "${COMMON[@]}" \
      --set "fullnameOverride=${SERVICE}" --set canary.enabled=false --atomic --wait --timeout 10m
    helm uninstall "${SERVICE}-canary" --namespace "$NS" --ignore-not-found ;;
  canary-abort)
    helm uninstall "${SERVICE}-canary" --namespace "$NS" --ignore-not-found ;;
  rollback)
    helm rollback "$SERVICE" --namespace "$NS" --wait --timeout 10m \
      || echo "##vso[task.logissue type=warning]nothing to roll back for ${SERVICE}" ;;
  verify)
    kubectl --namespace "$NS" rollout status "deployment/${SERVICE}" --timeout=5m
    restarts="$(kubectl --namespace "$NS" get pods -l "app.kubernetes.io/name=${SERVICE}" \
      -o jsonpath='{range .items[*]}{.status.containerStatuses[0].restartCount}{"\n"}{end}' | awk '{s+=$1} END{print s+0}')"
    echo "container restarts: ${restarts}"
    [[ "$restarts" -le 1 ]] ;;
  *) echo "unknown mode: $MODE" >&2; exit 2 ;;
esac
