import { useEffect, useState } from "react";
import { useParams } from "react-router-dom";

import { CaseSummary, getCase } from "../api/dataApi";
import ClinicalDataPanel from "../components/ClinicalDataPanel";
import PageHeader from "../components/PageHeader";
import StudiesPanel from "../components/StudiesPanel";

type Tab = "studies" | "clinical-data";

const tabs: { id: Tab; label: string }[] = [
  { id: "studies", label: "Studies" },
  { id: "clinical-data", label: "Clinical Data" },
];

export default function CaseDetailPage() {
  const { caseId } = useParams<{ caseId: string }>();
  const [tab, setTab] = useState<Tab>("studies");
  const [caseInfo, setCaseInfo] = useState<CaseSummary | null>(null);

  useEffect(() => {
    if (caseId) getCase(caseId).then(setCaseInfo);
  }, [caseId]);

  if (!caseId) return null;

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title={`Patient ${caseInfo?.patient_pseudonym_id.slice(0, 8) ?? ""}…`}
        subtitle={caseInfo?.accession_number ? `Accession number: ${caseInfo.accession_number}` : "No accession number"}
      />

      <div className="flex gap-1 border-b border-gray-200/70">
        {tabs.map((t) => (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            className={`-mb-px border-b-2 px-3 py-2 text-sm font-medium transition-colors ${
              tab === t.id
                ? "border-brand-600 text-brand-700"
                : "border-transparent text-gray-500 hover:text-gray-800"
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {tab === "studies" && <StudiesPanel caseId={caseId} />}
      {tab === "clinical-data" && <ClinicalDataPanel caseId={caseId} />}
    </div>
  );
}
