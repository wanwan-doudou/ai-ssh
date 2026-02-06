import { ServerList } from "../servers/ServerList";
import { ProviderList } from "../providers/ProviderList";
import { TerminalView } from "../terminal/TerminalView";

interface MainContentProps {
  activeView: "servers" | "providers" | "terminal";
  onNavigate: (view: "servers" | "providers" | "terminal") => void;
}

export function MainContent({ activeView, onNavigate }: MainContentProps) {
  return (
    <main className="relative z-0 flex-1 h-full overflow-hidden">
      {activeView === "servers" && <ServerList onNavigate={onNavigate} />}
      {activeView === "providers" && <ProviderList />}
      {activeView === "terminal" && <TerminalView />}
    </main>
  );
}
