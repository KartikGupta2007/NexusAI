import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, useLocation } from "react-router-dom";
import App from "../../App.tsx";
import { AppProvider } from "../../state/AppContext.tsx";

/**
 * Mounts the real application — real router, real provider, real hooks — on a MemoryRouter so a
 * test can start at any route and read where the app navigated to.
 */

/** Publishes the router's current path so a test can assert on navigation. */
const LocationProbe = ({ onChange }: { onChange: (path: string) => void }) => {
    onChange(useLocation().pathname);
    return null;
};

export interface RenderedApp {
    /** The route the app is currently on. */
    path: () => string;
    user: ReturnType<typeof userEvent.setup>;
    /** Resolves once the auth bootstrap has finished and the composer is on screen. */
    ready: () => Promise<HTMLTextAreaElement>;
    composer: () => HTMLTextAreaElement;
    /** Types a query and presses Enter. */
    ask: (query: string) => Promise<void>;
}

export const renderApp = (route = "/"): RenderedApp => {
    let current = route;

    render(
        <MemoryRouter initialEntries={[route]}>
            <LocationProbe onChange={(next) => { current = next; }} />
            <AppProvider>
                <App />
            </AppProvider>
        </MemoryRouter>,
    );

    // Advancing timers is never needed: every wait below is driven by real promise resolution.
    const user = userEvent.setup();
    const composer = () => screen.getByLabelText("Your question") as HTMLTextAreaElement;

    return {
        path: () => current,
        user,
        ready: async () => {
            await waitFor(() => expect(screen.getByLabelText("Your question")).toBeInTheDocument());
            return composer();
        },
        composer,
        ask: async (query: string) => {
            await user.click(composer());
            await user.keyboard(query);
            await user.keyboard("{Enter}");
        },
    };
};
