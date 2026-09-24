import { useEffect, useState } from "react";
import { Navigate, useParams, useSearchParams } from "react-router-dom";

import { listInstances } from "../api/dataApi";
import { safeReturnUrl } from "../lib/returnUrl";

/** Entry point for deep links from the main platform's admin-ui, which
 * knows a Study/Case/Series but never fetches Instances itself (that's
 * this repo's picker's job) -- resolves a seriesId to its first instance
 * and hands off to the real viewer route. */
export default function SeriesRedirectPage() {
  const { seriesId } = useParams<{ seriesId: string }>();
  const [searchParams] = useSearchParams();
  const studyId = searchParams.get("studyId");
  const jobId = searchParams.get("jobId");
  const caseId = searchParams.get("caseId");
  const viewAs = searchParams.get("viewAs");
  const returnUrl = safeReturnUrl(searchParams.get("returnUrl"));

  const [instanceId, setInstanceId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!seriesId) return;
    listInstances(seriesId)
      .then((list) => {
        const sorted = [...list].sort((a, b) => (a.instance_number ?? 0) - (b.instance_number ?? 0));
        if (sorted.length === 0) {
          setError("This series has no instances.");
          return;
        }
        setInstanceId(sorted[0].id);
      })
      .catch((err) => setError(String(err)));
  }, [seriesId]);

  if (error) {
    return (
      <div className="mx-auto mt-16 max-w-md text-center">
        <p className="alert-error">{error}</p>
      </div>
    );
  }

  if (!seriesId || !instanceId) {
    return <div className="mx-auto mt-16 max-w-md text-center text-sm text-gray-500">Loading series…</div>;
  }

  const jobParam = jobId ? `&jobId=${jobId}` : "";
  const caseParam = caseId ? `&caseId=${caseId}` : "";
  // viewAs travels through this redirect too -- otherwise an admin's
  // "View as" choice (carried as a URL param, since the viewer is a
  // different origin from admin-ui and can't share its storage) would
  // silently reset to "admin" on every deep link, which always arrives
  // via this /viewer/series/... route.
  const viewAsParam = viewAs ? `&viewAs=${viewAs}` : "";
  const returnParam = returnUrl ? `&returnUrl=${encodeURIComponent(returnUrl)}` : "";
  return (
    <Navigate
      to={`/viewer/${instanceId}?studyId=${studyId ?? ""}&seriesId=${seriesId}${jobParam}${caseParam}${viewAsParam}${returnParam}`}
      replace
    />
  );
}
