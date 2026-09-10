import { createContext, ReactNode, useCallback, useContext, useEffect, useMemo, useState } from "react";

import { getMe, Me } from "../api/adminApi";
import { isClinicianApp } from "../config";

/** Roles that may change a study's data and its workflow board. The
 * backend enforces exactly this set (`_WRITE_ROLES` / "data_manager",
 * "admin") -- mirrored here only to show/hide UI, never as the control. */
const MANAGE_ROLES = new Set(["admin", "data_manager"]);

/** Roles whose whole job is done from My Jobs and the annotation/review
 * surfaces -- they never need the study/patient/configuration screens.
 * (A "viewer" is deliberately not here: read-only study access is the
 * point of that role.) */
const WORKBENCH_ROLES = new Set(["annotator", "reviewer"]);

interface MeValue {
  me: Me | null;
  /** True while the first /admin/me request is still in flight. */
  loading: boolean;
  isAdmin: boolean;
  /** The caller's role in a study ("admin" for a global admin), or null. */
  roleFor: (studyId: string) => string | null;
  /** May create/edit/delete cases, upload, and edit the workflow board. */
  canManage: (studyId: string) => boolean;
  /** May edit the study itself and its members. */
  canAdminister: (studyId: string) => boolean;
  /** The reduced "just my jobs" workbench instead of the full admin UI.
   * True for a pure annotator/reviewer (every membership is one of
   * those roles, or none at all) and always inside the clinician desktop
   * shell: such a user gets one page with their jobs plus the
   * annotation/review surfaces, none of the study/patient/configuration
   * screens. Admins, data managers and viewers see the full UI. */
  jobsOnly: boolean;
  refresh: () => void;
}

const MeContext = createContext<MeValue | null>(null);

/** Loads "who am I" once per app load (global admin flag + study
 * memberships) so every page can gate its actions on the caller's real
 * role instead of showing buttons that would only fail with a 403. The
 * app renders once the answer is in -- a brief blank beats admin-only
 * controls flashing in and out for a non-admin. */
export function MeProvider({ children }: { children: ReactNode }) {
  const [me, setMe] = useState<Me | null>(null);
  const [loading, setLoading] = useState(true);
  const [version, setVersion] = useState(0);

  useEffect(() => {
    let cancelled = false;
    getMe()
      .then((value) => {
        if (!cancelled) setMe(value);
      })
      .catch(() => {
        // Treated as "no roles" -- every page still works read-only, and
        // the backend's own checks remain the real access control.
        if (!cancelled) setMe(null);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [version]);

  const roleFor = useCallback(
    (studyId: string): string | null => {
      if (!me) return null;
      if (me.is_admin) return "admin";
      return me.memberships.find((m) => m.study_id === studyId)?.role ?? null;
    },
    [me]
  );

  const value = useMemo<MeValue>(() => {
    const isAdmin = Boolean(me?.is_admin);
    const workbenchUser = !isAdmin && (me?.memberships ?? []).every((m) => WORKBENCH_ROLES.has(m.role));
    return {
      me,
      loading,
      isAdmin,
      roleFor,
      canManage: (studyId) => MANAGE_ROLES.has(roleFor(studyId) ?? ""),
      canAdminister: (studyId) => roleFor(studyId) === "admin",
      jobsOnly: isClinicianApp || workbenchUser,
      refresh: () => setVersion((v) => v + 1),
    };
  }, [me, loading, roleFor]);

  if (loading) {
    return (
      <div className="flex min-h-screen items-center justify-center text-sm text-gray-400">Loading your workspace…</div>
    );
  }

  return <MeContext.Provider value={value}>{children}</MeContext.Provider>;
}

export function useMe(): MeValue {
  const value = useContext(MeContext);
  if (!value) throw new Error("useMe must be used inside <MeProvider>");
  return value;
}

/** Human label for a study role, for badges and the role chip. */
export function roleLabel(role: string | null): string {
  switch (role) {
    case "admin":
      return "Admin";
    case "data_manager":
      return "Data manager";
    case "annotator":
      return "Annotator";
    case "reviewer":
      return "Reviewer";
    case "viewer":
      return "Viewer";
    default:
      return "No role";
  }
}
