import { join } from 'path'
import { SubscriptionFiles } from '../subscriptions/private-files'
import type { RelayStateContext } from '../context'

// Presence includes an empty reservation, missing journal and an interrupted
// two-directory reserve. Reading a PID never makes a writer disappear.
export async function coreOwnerWorkspaceAbsent(context: RelayStateContext): Promise<boolean> {
  try {
    const files = new SubscriptionFiles(context)
    return !(await files.directory(join(context.stateRoot, 'CoreOwner/.session'), false))
  } catch {
    return false
  }
}
