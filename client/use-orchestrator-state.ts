import { useRpc } from "@getpaseo/plugin/client";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useState } from "react";
import {
  orchestratorControl,
  orchestratorGet,
  orchestratorWait,
  type ControlCommand,
  type OrchestratorSnapshot,
} from "../shared/orchestrator";
import {
  selectSnapshotWithoutRegression,
  startSynchronizationLoop,
  type SynchronizationStatus,
} from "./orchestrator-sync";

export interface OrchestratorStateResult {
  snapshot: OrchestratorSnapshot | undefined;
  isLoading: boolean;
  loadError: string | null;
  commandError: string | null;
  synchronization: SynchronizationStatus;
  commandPending: boolean;
  execute(command: ControlCommand): Promise<void>;
  reload(): Promise<void>;
}

const queryKey = (workspaceId: string) => ["openspec-orchestrator", workspaceId] as const;

function publicErrorMessage(error: unknown): string {
  return error instanceof Error && error.message.trim()
    ? error.message
    : "Не удалось связаться с оркестратором";
}

export function useOrchestratorState(workspaceId: string): OrchestratorStateResult {
  const getState = useRpc(orchestratorGet);
  const waitForState = useRpc(orchestratorWait);
  const sendControl = useRpc(orchestratorControl);
  const queryClient = useQueryClient();
  const [synchronization, setSynchronization] =
    useState<SynchronizationStatus>("connecting");
  const [commandError, setCommandError] = useState<string | null>(null);

  const stateQuery = useQuery({
    // Query хранит начальный snapshot; последующие ответы записываются в тот же cache.
    // Источник: https://tanstack.com/query/latest/docs/framework/react/reference/functions/useQuery
    queryKey: queryKey(workspaceId),
    queryFn: async () => {
      const beforeRequest = queryClient.getQueryData<OrchestratorSnapshot>(
        queryKey(workspaceId),
      );
      const response = await getState({ workspaceId });
      return selectSnapshotWithoutRegression(
        beforeRequest?.revision,
        queryClient.getQueryData<OrchestratorSnapshot>(queryKey(workspaceId)),
        response,
      );
    },
    staleTime: Number.POSITIVE_INFINITY,
    refetchOnMount: "always",
    retry: 2,
    retryDelay: (attempt) => Math.min(500 * 2 ** attempt, 4_000),
  });

  // Один последовательный effect владеет long-poll циклом. Cleanup не может отменить
  // plugin RPC, поэтому поздний ответ игнорируется флагом stopped.
  // Источник: https://react.dev/reference/react/useEffect#fetching-data-with-effects
  useEffect(() => {
    if (!stateQuery.data) return;
    const loop = startSynchronizationLoop({
      getCached: () =>
        queryClient.getQueryData<OrchestratorSnapshot>(queryKey(workspaceId)),
      wait: (revision) => waitForState({ workspaceId, revision }),
      resync: () => getState({ workspaceId }),
      // setQueryData обновляет общий Query cache без дополнительного запроса.
      // Источник: https://tanstack.com/query/latest/docs/framework/react/reference/classes/QueryClient#setquerydata
      apply: (snapshot) => queryClient.setQueryData(queryKey(workspaceId), snapshot),
      setStatus: setSynchronization,
    });
    return loop.stop;
  }, [getState, queryClient, stateQuery.data !== undefined, waitForState, workspaceId]);

  const controlMutation = useMutation({
    mutationFn: ({
      command,
      expectedRevision,
    }: {
      command: ControlCommand;
      expectedRevision: string;
    }) => sendControl({ workspaceId, command, expectedRevision }),
    retry: false,
    onSuccess: (response, variables) => {
      queryClient.setQueryData<OrchestratorSnapshot>(
        queryKey(workspaceId),
        (current) =>
          selectSnapshotWithoutRegression(
            variables.expectedRevision,
            current,
            response.snapshot,
          ),
      );
      setCommandError(response.status === "rejected" ? response.message : null);
    },
    onError: (error) => setCommandError(publicErrorMessage(error)),
  });

  const execute = useCallback(
    async (command: ControlCommand) => {
      const snapshot = queryClient.getQueryData<OrchestratorSnapshot>(
        queryKey(workspaceId),
      );
      if (!snapshot) return;
      setCommandError(null);
      await controlMutation.mutateAsync({
        command,
        expectedRevision: snapshot.revision,
      }).catch(() => undefined);
    },
    [controlMutation.mutateAsync, queryClient, workspaceId],
  );

  const reload = useCallback(async () => {
    setSynchronization("connecting");
    await stateQuery.refetch();
  }, [stateQuery.refetch]);

  return {
    snapshot: stateQuery.data,
    isLoading: stateQuery.isPending,
    loadError:
      !stateQuery.data && stateQuery.error ? publicErrorMessage(stateQuery.error) : null,
    commandError,
    synchronization,
    commandPending: controlMutation.isPending,
    execute,
    reload,
  };
}
