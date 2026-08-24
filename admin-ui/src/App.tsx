import { Navigate, Route, Routes } from "react-router-dom";

import Layout from "./components/Layout";
import AnnotationTypesPage from "./pages/AnnotationTypesPage";
import CaseDetailPage from "./pages/CaseDetailPage";
import DeidentificationProfilesPage from "./pages/DeidentificationProfilesPage";
import JobDetailPage from "./pages/JobDetailPage";
import MyJobsPage from "./pages/MyJobsPage";
import PatientDetailPage from "./pages/PatientDetailPage";
import PatientsPage from "./pages/PatientsPage";
import StudiesPage from "./pages/StudiesPage";
import StudyDetailPage from "./pages/StudyDetailPage";
import WorkflowBoardPage from "./pages/WorkflowBoardPage";

export default function App() {
  return (
    <Routes>
      <Route path="/studies/:studyId/workflow" element={<WorkflowBoardPage />} />
      <Route element={<Layout />}>
        <Route path="/" element={<Navigate to="/studies" replace />} />
        <Route path="/my-jobs" element={<MyJobsPage />} />
        <Route path="/my-jobs/:cardId" element={<JobDetailPage />} />
        <Route path="/studies" element={<StudiesPage />} />
        <Route path="/studies/:studyId" element={<StudyDetailPage />} />
        <Route path="/studies/:studyId/cases/:caseId" element={<CaseDetailPage />} />
        <Route path="/patients" element={<PatientsPage />} />
        <Route path="/patients/:patientId" element={<PatientDetailPage />} />
        <Route path="/annotation-types" element={<AnnotationTypesPage />} />
        <Route path="/deidentification-profiles" element={<DeidentificationProfilesPage />} />
      </Route>
    </Routes>
  );
}
