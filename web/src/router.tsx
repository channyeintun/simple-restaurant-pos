import type { StaffRole } from '@pos/shared';
import { Navigate, type RouteDefinition } from '@solidjs/router';
import { useMe } from './lib/queries.js';
/*
 * The contract with `pages/`, which another agent owns. Milestone 0's pages are
 * shells; the routes below are what they hang off, and the names are the file
 * names:
 *
 *   ClaimPage       pages/ClaimPage.tsx       redeems a device link
 *   PinPage         pages/PinPage.tsx         the four-digit staff switch
 *   WaiterPage      pages/WaiterPage.tsx      tables + cart      (milestone 2)
 *   CashierPage     pages/CashierPage.tsx     open checks        (milestone 3)
 *   BackofficePage  pages/BackofficePage.tsx  the six lists      (milestone 1)
 */
import { BackofficePage } from './pages/BackofficePage.js';
import { CashierPage } from './pages/CashierPage.js';
import { ClaimPage } from './pages/ClaimPage.js';
import { PinPage } from './pages/PinPage.js';
import { WaiterPage } from './pages/WaiterPage.js';

/**
 * Every address in the app.
 *
 * Five screens and three of them are trees, which is the whole shape of this
 * product: a tablet is a waiter's, a cashier's or a manager's for the length of
 * a shift, and the two screens in front of that — claiming the device and
 * picking who is on — are the ones that decide which.
 *
 * `@solidjs/router` rather than the fifty-line hand-rolled router the reference
 * carries, because that one existed to avoid a dependency for five flat screens
 * and this app has nested trees, deep links a cashier reloads mid-service, and
 * three different homes. The shell in `App.tsx` is the router's root layout, so
 * every route below renders inside it and inherits its decision about whether
 * this tablet is claimed and whether anybody is signed in on it — no route here
 * has to check for itself.
 */

/**
 * Where a signed-in device goes when it is pointed at `/`.
 *
 * The role decides, because the role is what the device is for — a waiter
 * tablet that opened on a chooser would be a screen somebody has to get past
 * forty times a shift. A device with nobody on it never reaches this: the shell
 * sends it to the PIN screen first, and `null` is here for the type rather than
 * because it is expected.
 */
export function homePathFor(role: StaffRole | null): string {
  switch (role) {
    case 'waiter':
      return '/waiter';
    case 'cashier':
      return '/cashier';
    /*
     * A manager's home is the backoffice, not the waiter screen. Somebody with
     * the admin role is on the tablet to change a price or mint a device link;
     * when they are actually waiting tables they are one tap away in the nav,
     * and the till has not decided for them.
     */
    case 'admin':
      return '/backoffice';
    /*
     * Nobody on, or a role this build has never heard of — a tablet running
     * last month's bundle against a Worker that grew a fourth role. Both mean
     * the same thing to a router: there is no screen to send this device to,
     * so send it to the one that decides who is on.
     */
    case null:
    default:
      return '/staff';
  }
}

/**
 * `/` and anything unrecognised: send the device to its own home.
 *
 * Reads the session out of the query cache rather than being handed it. The
 * shell has already fetched it by the time any route renders, so this is a
 * cache hit and not a second request — and it means the redirect cannot be
 * rendered with a role that has gone stale, which is what a prop passed down
 * from a shell that renders once would eventually be.
 */
function RoleHome() {
  const session = useMe();
  return <Navigate href={homePathFor(session.data?.identity.role ?? null)} />;
}

export const routes: RouteDefinition[] = [
  { path: '/', component: RoleHome },

  /*
   * The two screens that run before a device is anybody's.
   *
   * `/claim` is opened from a link an admin sent to this tablet, and the nonce
   * rides in the URL fragment — browsers never send a fragment to a server, so
   * the one-use credential stays out of access logs, proxy logs and `Referer`
   * headers on its way in.
   */
  { path: '/claim', component: ClaimPage },
  { path: '/staff', component: PinPage },

  /*
   * The three trees.
   *
   * Each is written as its own path plus a splat, so that `/waiter` and
   * `/waiter/table/tbl_7` both land on the same page today. Milestone 2 turns
   * the splat into named children under the same parent — a nested route
   * renders inside the page rather than replacing it, which is what keeps the
   * tables pane on screen while the right-hand pane changes tables.
   */
  { path: ['/waiter', '/waiter/*'], component: WaiterPage },
  { path: ['/cashier', '/cashier/*'], component: CashierPage },
  { path: ['/backoffice', '/backoffice/*'], component: BackofficePage },

  /*
   * No 404 screen, deliberately. The only ways to reach an address that does
   * not exist are a typo in the URL bar and a stale link from an older build,
   * and neither is worth a screen mid-service; a device that finds itself
   * nowhere goes home instead. `_redirects` already sends every path to
   * `index.html`, so this is the app's own last word on it rather than the
   * server's.
   */
  { path: '*', component: RoleHome },
];
