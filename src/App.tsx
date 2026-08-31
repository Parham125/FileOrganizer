import { useEffect, useState } from "react";
import { invoke } from "./bridge";
import { useLocalStorageState, useModel, useTheme } from "./store";
import type { HashAlgo, ViewId } from "./types";
import Sidebar from "./components/Sidebar";
import UpdateBanner from "./components/UpdateBanner";
import SearchView from "./views/SearchView";
import DuplicatesView from "./views/DuplicatesView";
import InsightsView from "./views/InsightsView";
import OrganizeView from "./views/OrganizeView";
import RulesView from "./views/RulesView";
import AssistantView from "./views/AssistantView";
import TrashView from "./views/TrashView";
import SettingsView from "./views/SettingsView";

export default function App() {
  const [view, setView] = useLocalStorageState<ViewId>("fo.view", "search");
  const [model, setModel] = useModel();
  const [algo, setAlgo] = useLocalStorageState<HashAlgo>("fo.algo", "blake3");
  const [theme, setTheme, isDark] = useTheme();
  const [indexed, setIndexed] = useState(0);

  useEffect(() => {
    invoke<number>("index_stats")
      .then(setIndexed)
      .catch(() => setIndexed(0));
  }, []);

  const goSettings = () => setView("settings");

  return (
    <div className="flex h-dvh flex-col overflow-hidden bg-paper text-ink md:flex-row">
      <Sidebar
        view={view}
        onView={setView}
        indexed={indexed}
        isDark={isDark}
        onToggleTheme={() => setTheme(isDark ? "light" : "dark")}
      />
      {/* relative: sr-only inputs in the views are position:absolute, and without a
          positioned ancestor they resolve against the page and drag the whole shell,
          sidebar included, into the document scroll. */}
      <main className="relative min-h-0 min-w-0 flex-1 overflow-y-auto">
        <div className="mx-auto max-w-3xl px-5 py-6 md:px-8 md:py-9">
          {view === "search" && (
            <SearchView indexed={indexed} onIndexed={setIndexed} />
          )}
          {view === "duplicates" && <DuplicatesView algo={algo} />}
          {view === "insights" && <InsightsView />}
          {view === "organize" && (
            <OrganizeView model={model} onGoSettings={goSettings} />
          )}
          {view === "rules" && <RulesView />}
          {view === "assistant" && (
            <AssistantView model={model} onGoSettings={goSettings} />
          )}
          {view === "trash" && <TrashView />}
          {view === "settings" && (
            <SettingsView
              model={model}
              onModel={setModel}
              algo={algo}
              onAlgo={setAlgo}
              theme={theme}
              onTheme={setTheme}
            />
          )}
        </div>
      </main>
      <UpdateBanner />
    </div>
  );
}
