import crossSpawn from "cross-spawn";

/**
 * Spawn a configured agent runtime.
 *
 * Node's native spawn() does not resolve npm-generated .cmd shims on Windows.
 * cross-spawn preserves native spawn semantics while resolving and safely
 * invoking those shims, so the default `pi` and `omp` commands work regardless
 * of whether their installation provides an executable or a .cmd launcher.
 */
export function spawnRuntimeCommand(command, args, options) {
  return crossSpawn(command, args, options);
}
