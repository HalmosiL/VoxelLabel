import { Route, Routes } from "react-router-dom";

import PickerPage from "./pages/PickerPage";
import SeriesRedirectPage from "./pages/SeriesRedirectPage";
import TutorialPage from "./pages/TutorialPage";
import ViewerPage from "./pages/ViewerPage";
import UsageTracker from "./usage/UsageTracker";

export default function App() {
  return (
    <>
      <UsageTracker />
      <Routes>
        <Route path="/" element={<PickerPage />} />
        <Route path="/viewer/:instanceId" element={<ViewerPage />} />
        <Route path="/viewer/series/:seriesId" element={<SeriesRedirectPage />} />
        <Route path="/tutorial" element={<TutorialPage />} />
      </Routes>
    </>
  );
}
