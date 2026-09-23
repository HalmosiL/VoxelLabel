import { useEffect } from "react";
import { useLocation } from "react-router-dom";

import { API } from "../config";
import keycloak from "../keycloak";
import RatingPrompt from "./RatingPrompt";
import { init, trackPageView } from "./tracker";

/** Mounted once inside the router: starts the usage tracker (through
 * this app's own backend, which proxies to admin-service -- see
 * backend/app/main.py's /usage routes) and reports every route change
 * as a page view carrying the viewer's job/case/series ids. Renders
 * only the occasional "how demanding was that case?" prompt. */
export default function UsageTracker() {
  const location = useLocation();
  useEffect(() => {
    init({
      app: "viewer",
      configUrl: `${API.annotator}/usage/config`,
      eventsUrl: `${API.annotator}/usage/events`,
      getToken: () => keycloak.token,
      version: __APP_VERSION__,
      snapshotUrl: `${API.annotator}/usage/snapshots`,
    });
  }, []);
  useEffect(() => {
    const params = new URLSearchParams(location.search);
    trackPageView(location.pathname, {
      study_id: params.get("studyId") ?? undefined,
      case_id: params.get("caseId") ?? undefined,
      job_id: params.get("jobId") ?? undefined,
      series_id: params.get("seriesId") ?? undefined,
    });
  }, [location.pathname, location.search]);
  return <RatingPrompt />;
}
