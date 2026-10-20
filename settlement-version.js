/** Event registration alone is insufficient: old runtimes may accept unknown event names. */
export function supportsSettlementVersion(version) {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/.exec(String(version));
  if (!match) return false;
  const [, major, minor, patch] = match.map(Number);
  return (major === 0 && (minor > 85 || (minor === 85 && patch >= 1))) || (major === 1 && minor >= 1);
}
