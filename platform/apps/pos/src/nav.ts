/* The rail's own definition.
 *
 * 02-POS-SPEC.md §2: "Icons: copy the exact SVG path data from NAVDEF in the
 * prototype." So this IS that constant, transcribed from
 * design/KashikeyoPOS Guest Theme v3.dc.html — path data unchanged, group
 * order unchanged, ids unchanged (they are the route segments).
 *
 * `minRank` is added here, from §2's own table and §1.5: "A module the current
 * rank cannot view is absent from the rail, not greyed." The rail reads it; the
 * server enforces the equivalent independently, because a hidden rail item is a
 * courtesy and not a control (07-SECURITY-RLS.md).
 */

export interface NavItem {
  id: string;
  label: string;
  icon: string;
  minRank: number;
}
export interface NavGroup { title: string; items: NavItem[] }

/* Rank ladder: Kitchen 1, Till 2, Manager 3, Admin 4, Owner 5. */
export const RANK = { kitchen: 1, till: 2, manager: 3, admin: 4, owner: 5 } as const;

export const NAV: NavGroup[] = [
  { title: 'Owner', items: [
    { id: 'owner', label: 'Owner Dashboard', minRank: 5, icon: 'M12 2.6 4.5 6v6.2c0 4.6 3.2 8.5 7.5 9.2 4.3-.7 7.5-4.6 7.5-9.2V6zM9 12l2 2 4-4' },
  ] },
  { title: 'Start here', items: [
    { id: 'today', label: 'Today', minRank: 3, icon: 'M12 8v4l3 2M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20z' },
    { id: 'start', label: 'How this works', minRank: 1, icon: 'M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20zM12 16v-4M12 8h.01' },
  ] },
  { title: 'Front of house', items: [
    { id: 'pos', label: 'POS Floor', minRank: 2, icon: 'M3 9.5 12 3l9 6.5V20a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1z' },
    { id: 'orders', label: 'Orders & Tickets', minRank: 2, icon: 'M6 2h9l5 5v15H6zM15 2v5h5M9 13h7M9 17h5' },
    { id: 'kds', label: 'Kitchen Display', minRank: 1, icon: 'M4 4h16v13H4zM8 21h8M12 17v4' },
    { id: 'reservations', label: 'Reservations', minRank: 2, icon: 'M3 5h18v16H3zM3 10h18M8 3v4M16 3v4' },
    { id: 'delivery', label: 'Delivery & QR', minRank: 2, icon: 'M3 7h11v8H3zM14 10h4l3 3v2h-7zM7 19a2 2 0 1 0 0-4 2 2 0 0 0 0 4zM18 19a2 2 0 1 0 0-4 2 2 0 0 0 0 4z' },
    { id: 'customers', label: 'Customers & Credit', minRank: 3, icon: 'M17 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2M9.5 7a3.5 3.5 0 1 1-7 0 3.5 3.5 0 0 1 7 0zM22 21v-2a4 4 0 0 0-3-3.9M16 3.1a4 4 0 0 1 0 7.8' },
    { id: 'promos', label: 'Promotions & Banners', minRank: 3, icon: 'M20.6 12.3 12 3.7H5v7l8.6 8.6a1.7 1.7 0 0 0 2.4 0l4.6-4.6a1.7 1.7 0 0 0 0-2.4zM8.5 8.5h.01' },
    { id: 'loyalty', label: 'Loyalty & Rewards', minRank: 3, icon: 'M12 2.8l2.4 4.9 5.4.8-3.9 3.8.9 5.4-4.8-2.5-4.8 2.5.9-5.4L4.2 8.5l5.4-.8zM8 18.5V22l4-2 4 2v-3.5' },
  ] },
  { title: 'Menu & kitchen', items: [
    { id: 'menu', label: 'Menu Master', minRank: 3, icon: 'M4 5h16M4 12h16M4 19h10' },
    { id: 'aimenu', label: 'AI Menu Builder', minRank: 4, icon: 'M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9zM19 17l.9 2.1L22 20l-2.1.9L19 23l-.9-2.1L16 20l2.1-.9z' },
    { id: 'recipes', label: 'Recipes & Costing', minRank: 3, icon: 'M4 19.5A2.5 2.5 0 0 1 6.5 17H20M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z' },
    { id: 'production', label: 'Production', minRank: 3, icon: 'M2 20h20V9l-6 4V9l-6 4V4H4z' },
  ] },
  { title: 'Stock', items: [
    { id: 'inventory', label: 'Inventory', minRank: 3, icon: 'M3 7l9-4 9 4v10l-9 4-9-4zM3 7l9 4 9-4M12 11v10' },
    { id: 'counts', label: 'Stock Counts', minRank: 3, icon: 'M9 11l3 3 8-8M20 12v7a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h9' },
    { id: 'ledger', label: 'Stock Ledger', minRank: 3, icon: 'M3 3v18h18M7 16l3-4 3 2 4-6' },
    { id: 'batches', label: 'Batches & Expiry', minRank: 3, icon: 'M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20zM12 6v6l4 2' },
  ] },
  { title: 'Purchasing', items: [
    { id: 'requests', label: 'Indent Requests', minRank: 2, icon: 'M4 4h16v6H4zM4 14h16v6H4zM8 7h.01M8 17h.01' },
    { id: 'purchases', label: 'Purchases / GRN', minRank: 3, icon: 'M6 2 3 6v14h18V6l-3-4zM3 6h18M16 10a4 4 0 0 1-8 0' },
    { id: 'dispatches', label: 'Dispatches', minRank: 3, icon: 'M1 3h15v13H1zM16 8h4l3 3v5h-7zM5.5 21a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5zM18.5 21a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5z' },
    { id: 'vendors', label: 'Vendors', minRank: 3, icon: 'M3 21h18M4 21V10l8-6 8 6v11M9 21v-5h6v5M9 12h.01M15 12h.01' },
  ] },
  { title: 'People', items: [
    { id: 'staff', label: 'Staff & Time Clock', minRank: 3, icon: 'M12 8a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM4 22v-2a6 6 0 0 1 6-6h4a6 6 0 0 1 6 6v2M12 11v3l2 1.5' },
    { id: 'payroll', label: 'Payroll & Pension', minRank: 4, icon: 'M2 7h20v12H2zM2 11h20M6 15h4M12 3v4M8 3h8' },
  ] },
  { title: 'Finance', items: [
    { id: 'analytics', label: 'Analytics & CFO', minRank: 4, icon: 'M4 20V10M10 20V4M16 20v-7M22 20H2' },
    { id: 'reports', label: 'Reports & Exports', minRank: 3, icon: 'M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3' },
    { id: 'accounting', label: 'Accounting Flow', minRank: 4, icon: 'M8 2h8v4H8zM6 6h12a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2zM9 12h6M9 16h6' },
    { id: 'costs', label: 'Operating Costs', minRank: 4, icon: 'M12 1v22M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6' },
    { id: 'assets', label: 'Equipment & Maintenance', minRank: 3, icon: 'M14.7 6.3a4 4 0 0 1-5.4 5.4L4 17v3h3l5.3-5.3a4 4 0 0 1 5.4-5.4l-2.6 2.6' },
  ] },
  { title: 'Chain', items: [
    { id: 'chain', label: 'Chain Overview', minRank: 5, icon: 'M3 3v18h18M7 15l4-5 3 3 5-7' },
    { id: 'branches', label: 'Outlets', minRank: 4, icon: 'M3 21h18M5 21V8l7-5 7 5v13M10 21v-6h4v6' },
    { id: 'users', label: 'Users & Roles', minRank: 4, icon: 'M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2M12.5 7a3.5 3.5 0 1 1-7 0 3.5 3.5 0 0 1 7 0zM17 11l2 2 4-4' },
    { id: 'logs', label: 'Audit Log', minRank: 3, icon: 'M14 2H6v20h12V8zM14 2v6h6M9 13h6M9 17h4' },
  ] },
  { title: 'Platform', items: [
    { id: 'sync', label: 'Sync & Devices', minRank: 3, icon: 'M21 12a9 9 0 1 1-3-6.7M21 3v6h-6' },
    { id: 'architecture', label: 'Architecture', minRank: 4, icon: 'M5 3h6v6H5zM13 15h6v6h-6zM8 9v6h5M5 15h6v6H5zM13 3h6v6h-6zM16 9v6' },
    { id: 'settings', label: 'Settings', minRank: 3, icon: 'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.6 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.6h.09A1.65 1.65 0 0 0 10 3.09V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9v.09a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z' },
  ] },
];

/** The modules a rank may see. §1.5: absent, not greyed. */
export function navFor(rank: number): NavGroup[] {
  return NAV
    .map((g) => ({ title: g.title, items: g.items.filter((i) => rank >= i.minRank) }))
    .filter((g) => g.items.length);
}

/** Where a rank lands at sign-in: the screen that rank came to work on.
 *
 *  Owner → the estate (§2: "First in the rail and the landing view for an owner
 *  sign-in"), kitchen → the KDS, everyone else → the floor.
 *
 *  NOT simply the first visible rail item. That put a cashier on "How this
 *  works" at the start of every shift, because `start` is rank 1 and sorts
 *  above POS Floor — an orientation page in front of somebody with a queue at
 *  the counter. It falls back to the first visible item only if the preferred
 *  home is not available to that rank, so a new rank can never land nowhere. */
export function landingFor(rank: number): string {
  /* A manager's shift starts with what is waiting, not with the till — that is
     what §2 means by "the manager's morning screen". A cashier and a kitchen
     hand land on the screen they work; an owner lands on the estate. */
  const prefer = rank >= 5 ? 'owner' : rank >= 3 ? 'today' : rank <= 1 ? 'kds' : 'pos';
  const visible = navFor(rank).flatMap((g) => g.items);
  return visible.find((i) => i.id === prefer)?.id ?? visible[0]?.id ?? 'start';
}
