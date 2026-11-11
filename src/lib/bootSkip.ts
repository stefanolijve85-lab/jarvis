/**
 * Skipping the start-up sequence.
 *
 * The sequence is paced by App (it waits before handing over to the live
 * interface) and drawn by Boot. The skip button lives in Boot; this is the one
 * place the two meet: App races its wait against `bootSkipped()`, Boot calls
 * `skipBoot()`.
 */

let release: (() => void) | null = null

/** Resolves when the user skips the current boot. */
export function bootSkipped(): Promise<void> {
  return new Promise((resolve) => {
    release = resolve
  })
}

export function skipBoot() {
  release?.()
  release = null
}
