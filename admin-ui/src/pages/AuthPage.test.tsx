import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

const submitRegistrationRequest = vi.fn();
vi.mock("../api/adminApi", () => ({ submitRegistrationRequest: (...a: unknown[]) => submitRegistrationRequest(...a) }));
vi.mock("../keycloak", () => ({ default: {} }));

import { ApiError } from "../api/client";
import AuthPage, { AUTH_NOTICE_KEY } from "./AuthPage";

afterEach(() => {
  vi.restoreAllMocks();
  sessionStorage.clear();
});

describe("AuthPage sign in", () => {
  it("exchanges the password directly with Keycloak (openid scope) and hands the tokens up", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ access_token: "a", refresh_token: "r", id_token: "i" }), { status: 200 })
    );
    const onAuthenticated = vi.fn();
    render(<AuthPage onAuthenticated={onAuthenticated} />);
    await userEvent.type(screen.getByLabelText("Username"), "doc");
    await userEvent.type(screen.getByLabelText("Password"), "pw");
    await userEvent.click(screen.getByTestId("signin-submit"));
    await waitFor(() => expect(onAuthenticated).toHaveBeenCalledWith({ access_token: "a", refresh_token: "r", id_token: "i" }));
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toMatch(/\/protocol\/openid-connect\/token$/);
    const body = init?.body as URLSearchParams;
    expect(body.get("grant_type")).toBe("password");
    expect(body.get("scope")).toBe("openid");
    expect(body.get("username")).toBe("doc");
  });

  it("shows an inline error on a wrong password and stays on the form", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({ error: "invalid_grant" }), { status: 401 }));
    const onAuthenticated = vi.fn();
    render(<AuthPage onAuthenticated={onAuthenticated} />);
    await userEvent.type(screen.getByLabelText("Username"), "doc");
    await userEvent.type(screen.getByLabelText("Password"), "nope");
    await userEvent.click(screen.getByTestId("signin-submit"));
    expect(await screen.findByText(/Incorrect username or password/)).toBeInTheDocument();
    expect(onAuthenticated).not.toHaveBeenCalled();
    expect(screen.getByTestId("signin-submit")).toBeEnabled();
  });

  it("shows the session-ended notice left by main.tsx, once", () => {
    sessionStorage.setItem(AUTH_NOTICE_KEY, "Your session ended -- please sign in again.");
    render(<AuthPage onAuthenticated={vi.fn()} />);
    expect(screen.getByTestId("auth-notice")).toHaveTextContent(/session ended/);
    expect(sessionStorage.getItem(AUTH_NOTICE_KEY)).toBeNull();
  });
});

describe("AuthPage create account", () => {
  it("submits a request without any password and shows the sent state", async () => {
    submitRegistrationRequest.mockResolvedValue({ id: "1", status: "pending" });
    render(<AuthPage onAuthenticated={vi.fn()} initialTab="register" />);
    await userEvent.type(screen.getByLabelText("First name"), "New");
    await userEvent.type(screen.getByLabelText("Last name"), "Doc");
    await userEvent.type(screen.getByLabelText("Username"), "new.doc");
    await userEvent.type(screen.getByLabelText(/^Email address/), "new@example.test");
    await userEvent.click(screen.getByTestId("register-submit"));
    expect(await screen.findByText("Request sent")).toBeInTheDocument();
    expect(submitRegistrationRequest).toHaveBeenCalledWith({ first_name: "New", last_name: "Doc", username: "new.doc", email: "new@example.test", note: null });
    expect(JSON.stringify(submitRegistrationRequest.mock.calls[0][0])).not.toMatch(/password/);
  });

  it("rejects a username with spaces before calling the API and surfaces a 409 from it", async () => {
    render(<AuthPage onAuthenticated={vi.fn()} initialTab="register" />);
    await userEvent.type(screen.getByLabelText("First name"), "A");
    await userEvent.type(screen.getByLabelText("Last name"), "B");
    await userEvent.type(screen.getByLabelText("Username"), "bad name");
    await userEvent.type(screen.getByLabelText(/^Email address/), "a@example.test");
    await userEvent.click(screen.getByTestId("register-submit"));
    expect(await screen.findByText(/letters, digits/)).toBeInTheDocument();
    expect(submitRegistrationRequest).not.toHaveBeenCalled();

    submitRegistrationRequest.mockRejectedValue(new ApiError(409, JSON.stringify({ detail: "An account with this username or email already exists" })));
    await userEvent.clear(screen.getByLabelText("Username"));
    await userEvent.type(screen.getByLabelText("Username"), "taken");
    await userEvent.click(screen.getByTestId("register-submit"));
    expect(await screen.findByText(/already exists/)).toBeInTheDocument();
  });
});
