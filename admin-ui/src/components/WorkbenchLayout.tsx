import { NavLink, Outlet } from "react-router-dom";

import Avatar from "./Avatar";
import { BriefcaseIcon, LogoutIcon, QuestionMarkCircleIcon } from "./icons";
import { GuideProvider, useGuideControls } from "../guide/GuideContext";
import keycloak from "../keycloak";
import { logout } from "../auth/logout";

/** The reduced shell for a pure annotator/reviewer (and the clinician
 * desktop app): a slim top bar with just My Jobs and the account, and a
 * single centred column underneath. No sidebar, no groups of admin
 * screens -- the person's work is their jobs and the annotation/review
 * surfaces those open, nothing else. UX only: the backend's role checks
 * are the real access control, as everywhere else. */
export default function WorkbenchLayout() {
  return (
    <GuideProvider>
      <WorkbenchShell />
    </GuideProvider>
  );
}

function WorkbenchShell() {
  const username = (keycloak.tokenParsed?.preferred_username as string) ?? "user";
  const fullName = (keycloak.tokenParsed?.name as string) ?? username;
  const guide = useGuideControls();

  return (
    // h-screen, not min-h-screen -- see Layout.tsx's AdminLayout for why:
    // the outer App.tsx shell is h-screen/overflow-hidden (so the admin
    // rail stays put), so this has to scroll its own <main> internally
    // instead of growing past the viewport and getting clipped with no
    // way to reach the rest of the page.
    <div className="flex h-screen flex-col">
      <header className="flex-shrink-0 border-b border-gray-200/70 bg-white/85 backdrop-blur-sm">
        <div className="mx-auto flex h-14 max-w-4xl items-center gap-6 px-6">
          <div className="flex items-center gap-2.5">
            <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-gradient-to-br from-brand-500 to-brand-700 text-xs font-bold text-white shadow-sm shadow-brand-600/30">
              VL
            </div>
            <span className="text-sm font-semibold text-gray-900">VoxelLabel</span>
          </div>

          <nav className="flex flex-1 items-center">
            <NavLink
              to="/my-jobs"
              data-guide="nav-my-jobs"
              className={({ isActive }) =>
                `flex items-center gap-2 rounded-lg px-3 py-1.5 text-sm font-medium transition-colors ${
                  isActive ? "bg-brand-50 text-brand-700" : "text-gray-600 hover:bg-gray-50 hover:text-gray-900"
                }`
              }
            >
              <BriefcaseIcon className="h-4 w-4" />
              My Jobs
            </NavLink>
          </nav>

          <div className="flex items-center gap-2.5">
            {guide.available && (
              <button
                onClick={guide.start}
                title="Replay the guided tour of this page"
                className="mr-1 flex items-center gap-1.5 rounded-lg border border-amber-300 bg-amber-50 px-2.5 py-1.5 text-sm font-semibold text-amber-800 shadow-sm transition-colors hover:bg-amber-100"
              >
                <QuestionMarkCircleIcon className="h-4 w-4" />
                Tutorial
              </button>
            )}
            <Avatar id={username} />
            <span className="hidden max-w-[12rem] truncate text-sm text-gray-700 sm:inline" title={username}>
              {fullName}
            </span>
            <button
              onClick={logout}
              title="Log out"
              className="flex h-8 w-8 items-center justify-center rounded-lg text-gray-400 transition-colors hover:bg-gray-100 hover:text-gray-700"
            >
              <LogoutIcon className="h-4 w-4" />
            </button>
          </div>
        </div>
      </header>

      <main className="flex-1 overflow-y-auto">
        <div className="mx-auto max-w-4xl px-6 py-8">
          <Outlet />
        </div>
      </main>
    </div>
  );
}
