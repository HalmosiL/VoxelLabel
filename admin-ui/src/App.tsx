import { ReactElement } from "react";
import { Navigate, Route, Routes } from "react-router-dom";

import { useMe } from "./auth/MeContext";
import AdminViewAsRail from "./components/AdminViewAsRail";
import Layout from "./components/Layout";
import AnnotationTypesPage from "./pages/AnnotationTypesPage";
import CaseDetailPage from "./pages/CaseDetailPage";
import DeidentificationProfilesPage from "./pages/DeidentificationProfilesPage";
import JobDetailPage from "./pages/JobDetailPage";
import JobsPage from "./pages/JobsPage";
import MyJobsPage from "./pages/MyJobsPage";
import NotificationsPage from "./pages/NotificationsPage";
import PatientDetailPage from "./pages/PatientDetailPage";
import PatientsPage from "./pages/PatientsPage";
import StudiesPage from "./pages/StudiesPage";
import StudyDetailPage from "./pages/StudyDetailPage";
import SystemPage from "./pages/SystemPage";
import UsagePage from "./pages/usage/UsagePage";
import UsersPage from "./pages/UsersPage";
import WorkflowBoardPage from "./pages/WorkflowBoardPage";
import UsageTracker from "./usage/UsageTracker";

/** Keeps a pure annotator/reviewer (or the clinician app) on their
 * workbench: any admin-side page -- studies, patients, configuration,
 * the workflow board -- bounces back to My Jobs instead of rendering a
 * screen full of controls their role would only get 403s from. The
 * job, case and viewer pages stay reachable. */
function FullUiOnly({ children }: { children: ReactElement }) {
  const { jobsOnly } = useMe();
  return jobsOnly ? <Navigate to="/my-jobs" replace /> : children;
}

/** The whole app, with the admin-only "View as" rail mounted once
 * alongside the router output -- so it sits in a fixed, consistent
 * place (a real sidebar, flush left) on every route, including the
 * workflow board's own standalone layout, instead of being wired
 * separately (and inconsistently) into each layout. */
export default function App() {
  // h-screen + overflow-hidden, not min-h-screen: every inner layout
  // (AdminLayout, WorkbenchLayout, WorkflowBoardPage) already scrolls its
  // own content internally within exactly one viewport -- letting this
  // outer row grow taller than that and scroll the whole document too is
  // what broke the rail's sticky positioning.
  return (
    <div className="flex h-screen overflow-hidden">
      <UsageTracker />
      <AdminViewAsRail />
      <div className="min-w-0 flex-1">
        <AppRoutes />
      </div>
    </div>
  );
}

function AppRoutes() {
  const { jobsOnly } = useMe();
  return (
    <Routes>
      <Route
        path="/studies/:studyId/workflow"
        element={
          <FullUiOnly>
            <WorkflowBoardPage />
          </FullUiOnly>
        }
      />
      <Route element={<Layout />}>
        <Route path="/" element={<Navigate to={jobsOnly ? "/my-jobs" : "/studies"} replace />} />
        <Route path="/my-jobs" element={<MyJobsPage />} />
        <Route path="/my-jobs/:cardId" element={<JobDetailPage />} />
        <Route path="/studies/:studyId/cases/:caseId" element={<CaseDetailPage />} />
        <Route
          path="/studies"
          element={
            <FullUiOnly>
              <StudiesPage />
            </FullUiOnly>
          }
        />
        <Route
          path="/studies/:studyId"
          element={
            <FullUiOnly>
              <StudyDetailPage />
            </FullUiOnly>
          }
        />
        <Route
          path="/patients"
          element={
            <FullUiOnly>
              <PatientsPage />
            </FullUiOnly>
          }
        />
        <Route
          path="/patients/:patientId"
          element={
            <FullUiOnly>
              <PatientDetailPage />
            </FullUiOnly>
          }
        />
        <Route
          path="/annotation-types"
          element={
            <FullUiOnly>
              <AnnotationTypesPage />
            </FullUiOnly>
          }
        />
        <Route
          path="/deidentification-profiles"
          element={
            <FullUiOnly>
              <DeidentificationProfilesPage />
            </FullUiOnly>
          }
        />
        <Route
          path="/users"
          element={
            <FullUiOnly>
              <UsersPage />
            </FullUiOnly>
          }
        />
        <Route
          path="/jobs"
          element={
            <FullUiOnly>
              <JobsPage />
            </FullUiOnly>
          }
        />
        <Route
          path="/notifications"
          element={
            <FullUiOnly>
              <NotificationsPage />
            </FullUiOnly>
          }
        />
        <Route
          path="/system"
          element={
            <FullUiOnly>
              <SystemPage />
            </FullUiOnly>
          }
        />
        <Route
          path="/usage"
          element={
            <FullUiOnly>
              <UsagePage />
            </FullUiOnly>
          }
        />
        <Route path="*" element={<Navigate to={jobsOnly ? "/my-jobs" : "/studies"} replace />} />
      </Route>
    </Routes>
  );
}

