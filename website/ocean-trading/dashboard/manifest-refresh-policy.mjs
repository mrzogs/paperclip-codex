export function shouldWebsiteScheduleManifestRebuild({ manifestExists, inputChanged, monitorRunning }) {
  if (monitorRunning) return false;
  return !manifestExists || inputChanged;
}
