import { Navigate, Route, Routes } from "react-router-dom";

import Layout from "./components/Layout";
import AnnotationTypesPage from "./pages/AnnotationTypesPage";
import CaseDetailPage from "./pages/CaseDetailPage";
import DeidentificationProfilesPage from "./pages/DeidentificationProfilesPage";
import PatientDetailPage from "./pages/PatientDetailPage";
import PatientsPage from "./pages/PatientsPage";
import ProjectDetailPage from "./pages/ProjectDetailPage";
import ProjectsPage from "./pages/ProjectsPage";

export default function App() {
  return (
    <Routes>
      <Route element={<Layout />}>
        <Route path="/" element={<Navigate to="/projects" replace />} />
        <Route path="/projects" element={<ProjectsPage />} />
        <Route path="/projects/:projectId" element={<ProjectDetailPage />} />
        <Route path="/projects/:projectId/cases/:caseId" element={<CaseDetailPage />} />
        <Route path="/patients" element={<PatientsPage />} />
        <Route path="/patients/:patientId" element={<PatientDetailPage />} />
        <Route path="/annotation-types" element={<AnnotationTypesPage />} />
        <Route path="/deidentification-profiles" element={<DeidentificationProfilesPage />} />
      </Route>
    </Routes>
  );
}
