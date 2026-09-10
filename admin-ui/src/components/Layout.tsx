import { NavLink, Outlet } from "react-router-dom";

import Avatar from "./Avatar";
import { BriefcaseIcon, LogoutIcon } from "./icons";
import WorkbenchLayout from "./WorkbenchLayout";
import { logout } from "../auth/logout";
import { useMe } from "../auth/MeContext";
import keycloak from "../keycloak";

const navGroups = [
  {
    label: "Workspace",
    items: [
      { to: "/my-jobs", label: "My Jobs", icon: BriefcaseIcon },
      { to: "/studies", label: "Studies", icon: FolderIcon },
      { to: "/patients", label: "Patients", icon: UserIcon },
    ],
  },
  {
    label: "Configuration",
    items: [
      { to: "/annotation-types", label: "Annotation Types", icon: TagIcon },
      { to: "/deidentification-profiles", label: "De-identification", icon: ShieldIcon },
      { to: "/users", label: "Users", icon: UsersIcon },
      { to: "/system", label: "System", icon: ServerIcon },
    ],
  },
];

// A study member without the global admin role (data manager or viewer):
// My Jobs and their own Studies. Patients (cross-study) and the whole
// Configuration group are global-admin-only endpoints, so showing them
// would only lead to 403s.
const memberNavGroups = [{ label: "Workspace", items: navGroups[0].items.slice(0, 2) }];

/** Picks the shell for the signed-in person: a pure annotator/reviewer
 * (or the clinician desktop app) gets the reduced WorkbenchLayout -- one
 * My Jobs page and the surfaces it opens; everyone else the full sidebar
 * with the screens their role can actually use. */
export default function Layout() {
  const { isAdmin, me, jobsOnly } = useMe();
  if (jobsOnly) return <WorkbenchLayout />;
  return <AdminLayout isAdmin={isAdmin} membershipCount={me?.memberships.length ?? 0} />;
}

function AdminLayout({ isAdmin, membershipCount }: { isAdmin: boolean; membershipCount: number }) {
  const username = (keycloak.tokenParsed?.preferred_username as string) ?? "user";
  const groups = isAdmin ? navGroups : memberNavGroups;
  const roleChip = isAdmin
    ? "Global admin"
    : membershipCount > 0
      ? `Member of ${membershipCount} stud${membershipCount === 1 ? "y" : "ies"}`
      : "No study access yet";

  return (
    <div className="flex min-h-screen">
      <aside className="flex w-64 flex-shrink-0 flex-col border-r border-gray-200/70 bg-white/80 backdrop-blur-sm">
        <div className="flex items-center gap-2.5 px-5 py-5">
          <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-gradient-to-br from-brand-500 to-brand-700 text-sm font-bold text-white shadow-sm shadow-brand-600/30">
            VL
          </div>
          <div>
            <div className="text-sm font-semibold leading-tight text-gray-900">VoxelLabel</div>
            <div className="text-xs leading-tight text-gray-400">Admin</div>
          </div>
        </div>

        <nav className="flex flex-1 flex-col gap-5 px-3 pt-2">
          {groups.map((group) => (
            <div key={group.label}>
              <div className="mb-1.5 px-3 text-[11px] font-semibold uppercase tracking-wider text-gray-400">
                {group.label}
              </div>
              <div className="flex flex-col gap-0.5">
                {group.items.map(({ to, label, icon: Icon }) => (
                  <NavLink
                    key={to}
                    to={to}
                    className={({ isActive }) =>
                      `group flex items-center gap-2.5 rounded-lg px-3 py-2 text-sm font-medium transition-colors ${
                        isActive ? "bg-brand-50 text-brand-700" : "text-gray-600 hover:bg-gray-50 hover:text-gray-900"
                      }`
                    }
                  >
                    {({ isActive }) => (
                      <>
                        <span
                          className={`flex h-6 w-6 items-center justify-center rounded-md transition-colors ${
                            isActive ? "bg-brand-100 text-brand-600" : "bg-gray-100 text-gray-400 group-hover:text-gray-600"
                          }`}
                        >
                          <Icon className="h-3.5 w-3.5" />
                        </span>
                        {label}
                      </>
                    )}
                  </NavLink>
                ))}
              </div>
            </div>
          ))}
        </nav>

        <div className="flex items-center gap-2.5 border-t border-gray-200/70 p-4">
          <Avatar id={username} />
          <span className="flex min-w-0 flex-1 flex-col">
            <span className="truncate text-sm font-medium text-gray-700">{username}</span>
            <span className="truncate text-[11px] text-gray-400">{roleChip}</span>
          </span>
          <button
            onClick={logout}
            title="Log out"
            className="flex h-8 w-8 items-center justify-center rounded-lg text-gray-400 transition-colors hover:bg-gray-100 hover:text-gray-700"
          >
            <LogoutIcon className="h-4 w-4" />
          </button>
        </div>
      </aside>

      <main className="flex-1 overflow-y-auto">
        <div className="mx-auto max-w-5xl px-8 py-8">
          <Outlet />
        </div>
      </main>
    </div>
  );
}


function FolderIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 20 20" fill="currentColor">
      <path d="M2 4a2 2 0 012-2h4l2 2h6a2 2 0 012 2v8a2 2 0 01-2 2H4a2 2 0 01-2-2V4z" />
    </svg>
  );
}

function UserIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 20 20" fill="currentColor">
      <path
        fillRule="evenodd"
        d="M10 8a3 3 0 100-6 3 3 0 000 6zM3.465 14.493a1.23 1.23 0 00.41 1.412A9.957 9.957 0 0010 18c2.31 0 4.438-.784 6.131-2.1.43-.333.604-.903.408-1.41a7.002 7.002 0 00-13.074.003z"
        clipRule="evenodd"
      />
    </svg>
  );
}

function UsersIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 20 20" fill="currentColor">
      <path d="M7 8a3 3 0 100-6 3 3 0 000 6zM14.5 8a2.5 2.5 0 100-5 2.5 2.5 0 000 5zM1.5 16.5a5.5 5.5 0 0111 0 .5.5 0 01-.5.5H2a.5.5 0 01-.5-.5zM12.5 17a5.47 5.47 0 00-.9-3.03A5.5 5.5 0 0118.5 16.5a.5.5 0 01-.5.5h-5.5z" />
    </svg>
  );
}

function TagIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 20 20" fill="currentColor">
      <path
        fillRule="evenodd"
        d="M17.707 9.293l-7-7A1 1 0 0010 2H3a1 1 0 00-1 1v7a1 1 0 00.293.707l7 7a1 1 0 001.414 0l7-7a1 1 0 000-1.414zM6 6a1 1 0 100 2 1 1 0 000-2z"
        clipRule="evenodd"
      />
    </svg>
  );
}

function ShieldIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 20 20" fill="currentColor">
      <path
        fillRule="evenodd"
        d="M10 1l7 3v6c0 4.418-3.134 7.803-7 9-3.866-1.197-7-4.582-7-9V4l7-3zm0 3.5a1 1 0 00-1 1v4a1 1 0 001 1 1 1 0 001-1v-4a1 1 0 00-1-1zm0 8a1 1 0 100 2 1 1 0 000-2z"
        clipRule="evenodd"
      />
    </svg>
  );
}


function ServerIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 20 20" fill="currentColor">
      <path
        fillRule="evenodd"
        d="M2 4.5A2.5 2.5 0 014.5 2h11A2.5 2.5 0 0118 4.5v2A2.5 2.5 0 0115.5 9h-11A2.5 2.5 0 012 6.5v-2zm3 1a.75.75 0 100 1.5h.5a.75.75 0 000-1.5H5zm-3 8A2.5 2.5 0 014.5 11h11a2.5 2.5 0 012.5 2.5v2a2.5 2.5 0 01-2.5 2.5h-11A2.5 2.5 0 012 15.5v-2zm3 1a.75.75 0 100 1.5h.5a.75.75 0 000-1.5H5z"
        clipRule="evenodd"
      />
    </svg>
  );
}

