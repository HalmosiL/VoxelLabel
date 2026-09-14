import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import LabelFormModal, { fieldProblem, LabelField } from "./LabelFormModal";

describe("fieldProblem", () => {
  const all: LabelField[] = [
    { name: "Type", kind: "choice", options: ["solid", "sub-solid"] },
    { name: "Calcified", kind: "check" },
  ];
  it("accepts complete fields", () => {
    expect(fieldProblem(all[0], all)).toBeNull();
    expect(fieldProblem(all[1], all)).toBeNull();
  });
  it("names the problem", () => {
    expect(fieldProblem({ name: " ", kind: "check" }, all)).toMatch(/name/);
    expect(fieldProblem({ name: "type", kind: "check" }, [...all, { name: "type", kind: "check" }])).toMatch(/Another field/);
    expect(fieldProblem({ name: "Type", kind: "choice", options: ["solid"] }, [])).toMatch(/two options/);
    expect(fieldProblem({ name: "Confidence", kind: "scale", min: 5, max: 5 }, [])).toMatch(/greater/);
  });
});

describe("LabelFormModal", () => {
  it("builds a pick-one field from typed options and saves the cleaned form", async () => {
    const user = userEvent.setup();
    const onSave = vi.fn();
    render(<LabelFormModal labelName="Nodule" color="#ef4444" fields={[{ name: "Calcified", kind: "check" }]} onSave={onSave} onClose={() => {}} />);
    expect(screen.getByRole("dialog", { name: "Nodule · form" })).toBeInTheDocument();
    expect(screen.getAllByTestId("form-field")).toHaveLength(1);

    await user.click(screen.getByTestId("add-choice"));
    const field = screen.getAllByTestId("form-field")[1];
    // Unnamed and without options: Save is blocked and the reasons are shown.
    expect(screen.getByRole("button", { name: "Save form" })).toBeDisabled();
    await user.type(within(field).getByLabelText("Field name"), "Type");
    const optionInput = within(field).getByLabelText("New option");
    await user.type(optionInput, "solid{Enter}");
    await user.type(optionInput, "sub-solid, ground-glass{Enter}");
    expect(within(field).getByTestId("options").textContent).toContain("solid");
    expect(within(field).getByTestId("options").textContent).toContain("ground-glass");
    expect(screen.queryByTestId("field-problem")).not.toBeInTheDocument();
    // The preview mirrors the draft.
    expect(within(screen.getByTestId("form-preview")).getByText("ground-glass")).toBeInTheDocument();

    fireEvent.submit(screen.getByTestId("label-form-modal"));
    expect(onSave).toHaveBeenCalledWith([
      { name: "Calcified", kind: "check" },
      { name: "Type", kind: "choice", options: ["solid", "sub-solid", "ground-glass"] },
    ]);
  });

  it("switches a field's kind and reorders", async () => {
    const user = userEvent.setup();
    const onSave = vi.fn();
    render(
      <LabelFormModal
        labelName="Nodule"
        color="#ef4444"
        fields={[
          { name: "Calcified", kind: "check" },
          { name: "Confidence", kind: "scale", min: 1, max: 5 },
        ]}
        onSave={onSave}
        onClose={() => {}}
      />
    );
    const [first] = screen.getAllByTestId("form-field");
    await user.click(within(first).getByRole("button", { name: "Move down" }));
    const [nowFirst] = screen.getAllByTestId("form-field");
    expect(within(nowFirst).getByLabelText("Field name")).toHaveValue("Confidence");
    await user.click(within(nowFirst).getByRole("radio", { name: "Tick" }));
    fireEvent.submit(screen.getByTestId("label-form-modal"));
    expect(onSave).toHaveBeenCalledWith([
      { name: "Confidence", kind: "check" },
      { name: "Calcified", kind: "check" },
    ]);
  });
});
