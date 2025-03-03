import { isWorkspace, useWorkspace } from "hooks/useWorkspace";
import { now } from "lodash-es";
import { useAsync } from "react-async-hook";

export function BootstrapService() {
  const { load } = useWorkspace();
  useAsync(async () => {
    try {
      const workspace = new URLSearchParams(location.search).get("workspace");
      if (workspace && isWorkspace(workspace)) {
        const name = workspace.split("/").pop() ?? workspace;
        const a = await fetch(workspace);
        load(
          new File([await a.blob()], name, { lastModified: now() }),
          new URL(workspace).origin
        );
      }
    } catch (e) {
      console.warn(e);
    }
  }, []);
  return <></>;
}
