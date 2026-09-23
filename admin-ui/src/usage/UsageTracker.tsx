import { useEffect } from "react";
import { useLocation } from "react-router-dom";

import { API } from "../config";
import keycloak from "../keycloak";
import { init, trackPageView } from "./tracker";

/** Mounted once inside the router: starts the usage tracker and reports
 * every route change as a page view. Renders nothing. */
export default function UsageTracker() {
  const location = useLocation();
  useEffect(() => {
    init({
      app: "admin-ui",
      configUrl: `${API.admin}/admin/usage/config`,
      eventsUrl: `${API.admin}/admin/usage/events`,
      getToken: () => keycloak.token,
      version: __APP_VERSION__,
    });
  }, []);
  useEffect(() => {
    trackPageView(location.pathname);
  }, [location.pathname]);
  return null;
}
