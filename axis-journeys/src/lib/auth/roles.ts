/**
 * Roles and permissions, exactly the `ROLES` map in `prototype/admin/api.js`.
 * The rank is the gate: `need(perm)` on every route, and the same map drives what the CMS draws —
 * a screen that hides a control the server would allow, or draws one it would refuse, is a screen
 * that teaches an operator the app is broken.
 */

export type Role = 'owner' | 'editor' | 'contributor' | 'sales'
export type Permission = 'read' | 'write' | 'publish' | 'delete' | 'settings' | 'users' | 'enquiries' | 'media'

export const ROLES: Record<Role, { label: string; can: Permission[] }> = {
  owner: { label: 'Owner', can: ['read', 'write', 'publish', 'delete', 'settings', 'users', 'enquiries', 'media'] },
  editor: { label: 'Editor', can: ['read', 'write', 'publish', 'delete', 'enquiries', 'media', 'settings'] },
  contributor: { label: 'Contributor', can: ['read', 'write', 'media'] },
  sales: { label: 'Sales', can: ['read', 'enquiries'] },
}

export const ROLE_KEYS = Object.keys(ROLES) as Role[]

export const isRole = (v: unknown): v is Role => typeof v === 'string' && (ROLE_KEYS as string[]).includes(v)

/**
 * The gate. The lookup is `Object.hasOwn` rather than an `undefined` check because `ROLES['__proto__']`
 * is not undefined — it is the prototype — so the plain check let a crafted role string through to
 * `.can.includes` and threw. It never granted anything, but a 500 from a value a caller chose is a
 * gate that can be made to fail, and a gate is the wrong place to be surprised.
 */
export const can = (role: Role | null | undefined, perm: Permission): boolean =>
  !!role && Object.hasOwn(ROLES, role) && ROLES[role].can.includes(perm)
