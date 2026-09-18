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
import { CashierBoard } from './pages/cashier/Board.js';
import { CashierCheck } from './pages/cashier/CheckView.js';
import { ClaimPage } from './pages/ClaimPage.js';
import { PinPage } from './pages/PinPage.js';
import { PickTable, WaiterPage } from './pages/WaiterPage.js';
import { OrderPane } from './pages/waiter/OrderPane.js';

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
   * The waiter's is nested and the other two are not, and the difference is
   * what each screen does when you move within it. A nested route renders
   * *inside* its parent, so `/waiter/table/tbl_7` replaces only the right-hand
   * pane and leaves the tables grid exactly where it was — same scroll
   * position, no refetch, no flicker. That is what makes the grid usable as
   * navigation rather than as a screen you pass through, and it is the reason
   * the waiter's page is a layout with children rather than one component
   * reading the path.
   *
   * The cashier and the backoffice have nothing that stays put: opening a check
   * replaces the board, and a backoffice tab replaces the panel. They keep the
   * splat, which costs nothing and means neither grows a route table for
   * navigation it does not have.
   */
  {
    path: '/waiter',
    component: WaiterPage,
    children: [
      { path: '/', component: PickTable },
      /*
       * Three ways into the same pane, and they are three paths rather than one
       * with a mode parameter because the parameter *is* the mode: `tableId`
       * means find-or-open this table's check, `checkId` means add to that one,
       * and neither means start a new counter sale. `OrderPane` reads whichever
       * arrived and does not have to be told which kind it is.
       */
      { path: '/table/:tableId', component: OrderPane },
      { path: '/check/:checkId', component: OrderPane },
      { path: '/takeaway', component: OrderPane },
      { path: '*', component: PickTable },
    ],
  },
  /*
   * The cashier's is nested too, and for a different reason from the waiter's:
   * not to keep a pane on screen, but to keep the **stream** open. `createLive`
   * lives in `CashierPage`, which stays mounted while the board and one check
   * swap underneath it — a connection opened in either child would be torn down
   * and rebuilt, a ticket round trip and a fresh subscribe, every time somebody
   * opened a check and came back.
   */
  {
    path: '/cashier',
    component: CashierPage,
    children: [
      { path: '/', component: CashierBoard },
      { path: '/:checkId', component: CashierCheck },
      { path: '*', component: CashierBoard },
    ],
  },
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
