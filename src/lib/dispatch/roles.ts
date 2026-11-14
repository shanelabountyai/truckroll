import type { Permission } from '@/core/authz/permissions';
import type { Role } from '@/generated/prisma/enums';
import { can } from '@/core/authz/permissions';

// PRD §2: owner and admin dispatch; a member is a technician and sees only their own day. The foundation's permission
// list is template-owned, so the dispatcher gate reuses `org.update`, which exactly the owner and admin hold (D-25).
export const DISPATCH: Permission = 'org.update';

export const isDispatcher = (role: Role) => can(role, DISPATCH);
