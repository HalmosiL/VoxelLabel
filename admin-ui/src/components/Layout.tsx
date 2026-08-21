import { NavLink, Outlet } from "react-router-dom";

import Avatar from "./Avatar";
import keycloak from "../keycloak";

const navGroups = [
  {
    label: "Workspace",
    items: [
      { to: "/studies", label: "Studies", icon: FolderIcon },
      { to: "/patients", label: "Patients", icon: UserIcon },
    ],
  },
  {
    label: "Configuration",
    items: [
      { to: "/annotation-types", label: "Annotation Types", icon: TagIcon },
      { to: "/deidentification-profiles", label: "De-identification", icon: ShieldIcon },
    ],
  },
];

export default function Layout() {
  const username = (keycloak.tokenParsed?.preferred_username as string) ?? "user";

  return (
    <div className="flex min-h-screen">
      <aside className="flex w-64 flex-shrink-0 flex-col border-r border-gray-200/70 bg-white/80 backdrop-blur-sm">
        <div className="flex items-center gap-2.5 px-5 py-5">
          <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-gradient-to-br from-brand-500 to-brand-700 text-sm font-bold text-white shadow-sm shadow-brand-600/30">
            CT
          </div>
          <div>
            <div className="text-sm font-semibold leading-tight text-gray-900">Platform Admin</div>
            <div className="text-xs leading-tight text-gray-400">CT Annotation System</div>
          </div>
        </div>

        <nav className="flex flex-1 flex-col gap-5 px-3 pt-2">
          {navGroups.map((group) => (
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
          <span className="flex-1 truncate text-sm font-medium text-gray-700">{username}</span>
          <button
            onClick={() => keycloak.logout()}
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

function LogoutIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 20 20" fill="currentColor">
      <path
        fillRule="evenodd"
        d="M3 3a1 1 0 011-1h6a1 1 0 110 2H5v12h5a1 1 0 110 2H4a1 1 0 01-1-1V3zm10.293 3.293a1 1 0 011.414 0l3 3a1 1 0 010 1.414l-3 3a1 1 0 01-1.414-1.414L14.586 11H8a1 1 0 110-2h6.586l-1.293-1.293a1 1 0 010-1.414z"
        clipRule="evenodd"
      />
    </svg>
  );
}
