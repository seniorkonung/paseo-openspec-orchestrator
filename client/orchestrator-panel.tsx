import {
  type PluginWorkspacePanelProps,
  useWorkspace,
} from "@getpaseo/plugin/client";
import { FlatList } from "@getpaseo/plugin/client/react-native";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  type FlatList as NativeFlatList,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
  Pressable,
  StyleSheet,
  Text,
  View,
} from "react-native";
import type {
  AgentLink,
  CompletedAction,
  OrchestratorSnapshot,
} from "../shared/orchestrator";
import {
  commandLabels,
  currentStateDescription,
  formatDuration,
  formatChangeLabel,
  getTimelineUpdate,
  lifecycleLabels,
  outcomeSigns,
} from "./orchestrator-view-model";
import { useOrchestratorState } from "./use-orchestrator-state";

type Navigation = PluginWorkspacePanelProps["navigation"];

function AgentLinks({
  links,
  navigation,
  color,
  mutedColor,
}: {
  links: AgentLink[];
  navigation: Navigation;
  color: string;
  mutedColor: string;
}) {
  if (links.length === 0) return null;
  return (
    <View style={sharedStyles.links}>
      {links.map((link) =>
        navigation ? (
          <Pressable
            key={link.agentId}
            accessibilityRole="link"
            accessibilityLabel={`Открыть агента ${link.label}`}
            onPress={() => navigation.openAgent({ agentId: link.agentId })}
            style={({ pressed }) => [sharedStyles.linkPill, pressed && sharedStyles.pressed]}
          >
            <Text style={[sharedStyles.linkText, { color }]} numberOfLines={1}>
              @{link.label}
            </Text>
          </Pressable>
        ) : (
          <View key={link.agentId} style={sharedStyles.linkPill}>
            <Text style={[sharedStyles.linkText, { color: mutedColor }]} numberOfLines={1}>
              @{link.label}
            </Text>
          </View>
        ),
      )}
    </View>
  );
}

function outcomeColor(
  outcome: CompletedAction["outcome"],
  colors: PluginWorkspacePanelProps["theme"]["colors"],
): string {
  if (outcome === "succeeded") return colors.statusSuccess;
  if (outcome === "failed") return colors.statusDanger;
  return colors.foregroundMuted;
}

export function OrchestratorPanel({
  theme,
  layout,
  workspaceId,
  navigation,
}: PluginWorkspacePanelProps) {
  const workspace = useWorkspace(workspaceId, ({ directory, name, title }) => ({
    directory,
    name,
    title,
  }));
  const orchestrator = useOrchestratorState(workspaceId);
  const listRef = useRef<NativeFlatList<CompletedAction>>(null);
  const previousHistoryLength = useRef(0);
  const [atBottom, setAtBottom] = useState(true);
  const [newActionCount, setNewActionCount] = useState(0);
  const compact = layout.compact;
  const styles = useMemo(
    () => createStyles(theme.colors, compact),
    [compact, theme.colors],
  );

  const history = useMemo(
    () => (orchestrator.snapshot?.history ?? []).slice().reverse(),
    [orchestrator.snapshot?.history],
  );

  useEffect(() => {
    previousHistoryLength.current = 0;
    setAtBottom(true);
    setNewActionCount(0);
  }, [workspaceId]);

  useEffect(() => {
    const previous = previousHistoryLength.current;
    const update = getTimelineUpdate(previous, history.length, atBottom);
    previousHistoryLength.current = history.length;
    if (previous === 0 || update.added === 0) return;

    if (update.shouldScroll) {
      listRef.current?.scrollToOffset({ offset: 0, animated: true });
    } else {
      setNewActionCount((count) => count + update.added);
    }
  }, [atBottom, history.length]);

  const handleScroll = useCallback((event: NativeSyntheticEvent<NativeScrollEvent>) => {
    const nextAtBottom = event.nativeEvent.contentOffset.y <= 48;
    setAtBottom(nextAtBottom);
    if (nextAtBottom) setNewActionCount(0);
  }, []);

  const showLatest = useCallback(() => {
    listRef.current?.scrollToOffset({ offset: 0, animated: true });
    setAtBottom(true);
    setNewActionCount(0);
  }, []);

  const renderAction = useCallback(
    ({ item }: { item: CompletedAction }) => {
      const color = outcomeColor(item.outcome, theme.colors);
      return (
        <View style={styles.actionRow}>
          <View style={styles.actionRail} />
          <View style={[styles.actionMarker, { borderColor: color }]}>
            <Text style={[styles.actionSign, { color }]}>{outcomeSigns[item.outcome]}</Text>
          </View>
          <View style={styles.actionBody}>
            <Text style={styles.actionText}>{item.text}</Text>
            <View style={styles.actionMeta}>
              <Text style={styles.duration}>
                {formatDuration(item.startedAt, item.finishedAt)}
              </Text>
              <AgentLinks
                links={item.links}
                navigation={navigation}
                color={theme.colors.accent}
                mutedColor={theme.colors.foregroundMuted}
              />
            </View>
          </View>
        </View>
      );
    },
    [navigation, styles, theme.colors],
  );

  const workspaceName = workspace?.title?.trim() || workspace?.name || workspaceId;
  const snapshot = orchestrator.snapshot;
  const synchronizationLabel = orchestrator.loadError
    ? "Нет связи"
    : orchestrator.synchronization === "live"
      ? "Синхронизировано"
      : orchestrator.synchronization === "reconnecting"
        ? "Переподключение"
        : "Подключение";
  const synchronizationColor = orchestrator.loadError
    ? theme.colors.statusDanger
    : orchestrator.synchronization === "live"
      ? theme.colors.statusSuccess
      : theme.colors.statusWarning;

  return (
    <View style={styles.screen}>
      <View style={styles.header}>
        <View style={styles.boundary}>
          <View style={styles.headerTitleRow}>
            <View style={styles.headerIdentity}>
              <Text style={styles.eyebrow}>ОРКЕСТРАТОР OPENSPEC</Text>
              <Text style={styles.workspaceName} numberOfLines={1}>
                {workspaceName}
              </Text>
            </View>
            <View style={styles.syncState}>
              <View style={[styles.syncDot, { backgroundColor: synchronizationColor }]} />
              <Text style={styles.syncText}>{synchronizationLabel}</Text>
            </View>
          </View>
          <Text selectable style={styles.directory} numberOfLines={1}>
            {workspace?.directory ?? "Рабочая область загружается…"}
          </Text>
          <View style={styles.changeRow}>
            <Text style={styles.changeLabel}>CHANGE</Text>
            <Text style={styles.changeValue} numberOfLines={1}>
              {formatChangeLabel(snapshot?.change)}
            </Text>
          </View>
          {snapshot?.persistence.status === "degraded" ? (
            <View style={styles.warningBanner}>
              <Text style={styles.warningText}>{snapshot.persistence.message}</Text>
            </View>
          ) : null}
        </View>
      </View>

      <View style={styles.timelineContainer}>
        {orchestrator.isLoading && !snapshot ? (
          <View style={styles.centerState}>
            <ActivityIndicator color={theme.colors.accent} />
            <Text style={styles.centerTitle}>Загружаю состояние оркестратора</Text>
          </View>
        ) : orchestrator.loadError && !snapshot ? (
          <View style={styles.centerState}>
            <Text style={styles.errorTitle}>Не удалось загрузить оркестратор</Text>
            <Text style={styles.centerDescription}>{orchestrator.loadError}</Text>
            <Pressable
              accessibilityRole="button"
              onPress={() => void orchestrator.reload()}
              style={({ pressed }) => [styles.secondaryButton, pressed && sharedStyles.pressed]}
            >
              <Text style={styles.secondaryButtonText}>Повторить</Text>
            </Pressable>
          </View>
        ) : (
          // FlatList виртуализирует изменяемую ленту, а inverted даёт chat-поведение.
          // Источник: https://reactnative.dev/docs/flatlist
          <FlatList
            ref={listRef}
            data={history}
            inverted
            keyExtractor={(item) => item.id}
            renderItem={renderAction}
            onScroll={handleScroll}
            scrollEventThrottle={80}
            maintainVisibleContentPosition={{ minIndexForVisible: 0 }}
            contentContainerStyle={[
              styles.listContent,
              history.length === 0 && styles.emptyListContent,
            ]}
            ListEmptyComponent={
              <View style={styles.emptyState}>
                <View style={styles.emptyMarker} />
                <Text style={styles.centerTitle}>История действий пуста</Text>
                <Text style={styles.centerDescription}>
                  Запустите оркестратор — завершённые действия останутся здесь после
                  перезапуска плагина.
                </Text>
              </View>
            }
          />
        )}

        {newActionCount > 0 ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`Показать новые действия: ${newActionCount}`}
            onPress={showLatest}
            style={({ pressed }) => [styles.newActionsButton, pressed && sharedStyles.pressed]}
          >
            <Text style={styles.newActionsText}>
              Новые действия · {newActionCount}
            </Text>
          </Pressable>
        ) : null}
      </View>

      <CurrentStatePanel
        snapshot={snapshot}
        commandError={orchestrator.commandError}
        commandPending={orchestrator.commandPending}
        navigation={navigation}
        onCommand={orchestrator.execute}
        styles={styles}
        colors={theme.colors}
      />
    </View>
  );
}

function CurrentStatePanel({
  snapshot,
  commandError,
  commandPending,
  navigation,
  onCommand,
  styles,
  colors,
}: {
  snapshot: OrchestratorSnapshot | undefined;
  commandError: string | null;
  commandPending: boolean;
  navigation: Navigation;
  onCommand: (command: NonNullable<OrchestratorSnapshot["lifecycle"]["availableCommand"]>) =>
    Promise<void>;
  styles: ReturnType<typeof createStyles>;
  colors: PluginWorkspacePanelProps["theme"]["colors"];
}) {
  const lifecycle = snapshot?.lifecycle;
  const currentAction = snapshot?.currentAction;
  const transitionActive =
    lifecycle?.status === "starting" ||
    lifecycle?.status === "running" ||
    lifecycle?.status === "pausing";
  const command = lifecycle?.availableCommand ?? null;

  return (
    <View style={styles.currentPanel}>
      <View style={[styles.boundary, styles.currentBoundary]}>
        <View style={styles.currentMain}>
          <View style={styles.currentIndicator}>
            {transitionActive ? (
              <ActivityIndicator color={colors.accent} size="small" />
            ) : (
              <Text style={styles.stateGlyph}>
                {lifecycle?.status === "paused" ? "Ⅱ" : "●"}
              </Text>
            )}
          </View>
          <View style={styles.currentCopy}>
            <Text style={styles.currentStatus}>
              {lifecycle ? lifecycleLabels[lifecycle.status] : "Нет данных"}
            </Text>
            <Text style={styles.currentActionText} numberOfLines={3}>
              {currentAction?.text ?? currentStateDescription(snapshot)}
            </Text>
            {currentAction ? (
              <AgentLinks
                links={currentAction.links}
                navigation={navigation}
                color={colors.accent}
                mutedColor={colors.foregroundMuted}
              />
            ) : null}
          </View>
          {command ? (
            <Pressable
              accessibilityRole="button"
              accessibilityState={{ disabled: commandPending, busy: commandPending }}
              disabled={commandPending}
              onPress={() => void onCommand(command)}
              style={({ pressed }) => [
                styles.controlButton,
                commandPending && styles.controlButtonDisabled,
                pressed && sharedStyles.pressed,
              ]}
            >
              {commandPending ? (
                <ActivityIndicator color={colors.accentForeground} size="small" />
              ) : null}
              <Text style={styles.controlButtonText}>{commandLabels[command]}</Text>
            </Pressable>
          ) : null}
        </View>
        {commandError ? <Text style={styles.commandError}>{commandError}</Text> : null}
      </View>
    </View>
  );
}

const sharedStyles = StyleSheet.create({
  links: {
    flexDirection: "row",
    flexWrap: "wrap",
    alignItems: "center",
    gap: 6,
  },
  linkPill: {
    minHeight: 24,
    justifyContent: "center",
    borderRadius: 12,
    paddingHorizontal: 8,
    paddingVertical: 3,
  },
  linkText: {
    fontSize: 12,
    fontWeight: "600",
  },
  pressed: {
    opacity: 0.72,
  },
});

function createStyles(
  colors: PluginWorkspacePanelProps["theme"]["colors"],
  compact: boolean,
) {
  const horizontalPadding = compact ? 16 : 24;
  return StyleSheet.create({
    screen: {
      flex: 1,
      minHeight: 0,
      backgroundColor: colors.surface0,
    },
    boundary: {
      width: "100%",
      maxWidth: 960,
      alignSelf: "center",
    },
    header: {
      flexShrink: 0,
      borderBottomWidth: 1,
      borderBottomColor: colors.border,
      backgroundColor: colors.surface1,
      paddingHorizontal: horizontalPadding,
      paddingVertical: compact ? 12 : 16,
    },
    headerTitleRow: {
      flexDirection: "row",
      alignItems: "flex-start",
      justifyContent: "space-between",
      gap: 16,
    },
    headerIdentity: {
      flex: 1,
      minWidth: 0,
      gap: 3,
    },
    eyebrow: {
      color: colors.foregroundMuted,
      fontSize: 10,
      fontWeight: "700",
      letterSpacing: 0.8,
    },
    workspaceName: {
      color: colors.foreground,
      fontSize: compact ? 17 : 20,
      fontWeight: "600",
    },
    syncState: {
      flexDirection: "row",
      alignItems: "center",
      gap: 6,
      paddingTop: 3,
    },
    syncDot: {
      width: 7,
      height: 7,
      borderRadius: 4,
    },
    syncText: {
      color: colors.foregroundMuted,
      fontSize: 12,
    },
    directory: {
      marginTop: 5,
      color: colors.foregroundMuted,
      fontSize: 12,
    },
    changeRow: {
      marginTop: compact ? 9 : 12,
      flexDirection: "row",
      alignItems: "center",
      gap: 8,
    },
    changeLabel: {
      color: colors.foregroundMuted,
      fontSize: 10,
      fontWeight: "700",
      letterSpacing: 0.7,
    },
    changeValue: {
      flex: 1,
      color: colors.foreground,
      fontSize: 13,
      fontWeight: "500",
    },
    warningBanner: {
      marginTop: 10,
      borderWidth: 1,
      borderColor: colors.statusWarning,
      borderRadius: 8,
      paddingHorizontal: 10,
      paddingVertical: 8,
    },
    warningText: {
      color: colors.statusWarning,
      fontSize: 12,
      lineHeight: 17,
    },
    timelineContainer: {
      flex: 1,
      minHeight: 0,
      position: "relative",
    },
    listContent: {
      width: "100%",
      maxWidth: 960,
      alignSelf: "center",
      paddingHorizontal: horizontalPadding,
      paddingVertical: compact ? 14 : 22,
    },
    emptyListContent: {
      flexGrow: 1,
      justifyContent: "center",
    },
    actionRow: {
      minHeight: compact ? 58 : 66,
      flexDirection: "row",
      alignItems: "flex-start",
      gap: compact ? 10 : 14,
      position: "relative",
      paddingVertical: compact ? 9 : 11,
    },
    actionRail: {
      position: "absolute",
      left: compact ? 11 : 13,
      top: 0,
      bottom: 0,
      width: 1,
      backgroundColor: colors.border,
    },
    actionMarker: {
      width: compact ? 23 : 27,
      height: compact ? 23 : 27,
      borderRadius: compact ? 12 : 14,
      borderWidth: 1.5,
      alignItems: "center",
      justifyContent: "center",
      backgroundColor: colors.surface0,
      zIndex: 1,
    },
    actionSign: {
      fontSize: compact ? 12 : 14,
      fontWeight: "700",
      lineHeight: compact ? 15 : 17,
    },
    actionBody: {
      flex: 1,
      minWidth: 0,
      gap: 6,
      paddingTop: 1,
    },
    actionText: {
      color: colors.foreground,
      fontSize: compact ? 13 : 14,
      lineHeight: compact ? 19 : 21,
    },
    actionMeta: {
      minHeight: 24,
      flexDirection: "row",
      flexWrap: "wrap",
      alignItems: "center",
      gap: 8,
    },
    duration: {
      color: colors.foregroundMuted,
      fontSize: 11,
      fontVariant: ["tabular-nums"],
    },
    centerState: {
      flex: 1,
      alignItems: "center",
      justifyContent: "center",
      padding: 28,
      gap: 10,
    },
    emptyState: {
      alignItems: "center",
      alignSelf: "center",
      maxWidth: 440,
      gap: 8,
    },
    emptyMarker: {
      width: 11,
      height: 11,
      borderRadius: 6,
      borderWidth: 2,
      borderColor: colors.foregroundMuted,
      marginBottom: 4,
    },
    centerTitle: {
      color: colors.foreground,
      fontSize: compact ? 15 : 17,
      fontWeight: "600",
      textAlign: "center",
    },
    errorTitle: {
      color: colors.statusDanger,
      fontSize: compact ? 15 : 17,
      fontWeight: "600",
      textAlign: "center",
    },
    centerDescription: {
      color: colors.foregroundMuted,
      fontSize: compact ? 12 : 13,
      lineHeight: compact ? 18 : 20,
      textAlign: "center",
      maxWidth: 440,
    },
    secondaryButton: {
      minHeight: 36,
      justifyContent: "center",
      borderWidth: 1,
      borderColor: colors.border,
      borderRadius: 9,
      paddingHorizontal: 14,
      paddingVertical: 7,
      marginTop: 4,
    },
    secondaryButtonText: {
      color: colors.foreground,
      fontSize: 13,
      fontWeight: "600",
    },
    newActionsButton: {
      position: "absolute",
      bottom: 12,
      alignSelf: "center",
      borderWidth: 1,
      borderColor: colors.accent,
      borderRadius: 18,
      backgroundColor: colors.surface2,
      paddingHorizontal: 14,
      paddingVertical: 8,
    },
    newActionsText: {
      color: colors.accent,
      fontSize: 12,
      fontWeight: "700",
    },
    currentPanel: {
      flexShrink: 0,
      borderTopWidth: 1,
      borderTopColor: colors.border,
      backgroundColor: colors.surface1,
      paddingHorizontal: horizontalPadding,
      paddingVertical: compact ? 12 : 16,
    },
    currentBoundary: {
      gap: 8,
    },
    currentMain: {
      flexDirection: "row",
      alignItems: "center",
      gap: compact ? 10 : 14,
    },
    currentIndicator: {
      width: compact ? 28 : 32,
      alignItems: "center",
      justifyContent: "center",
    },
    stateGlyph: {
      color: colors.foregroundMuted,
      fontSize: compact ? 15 : 17,
      fontWeight: "700",
    },
    currentCopy: {
      flex: 1,
      minWidth: 0,
      gap: 3,
    },
    currentStatus: {
      color: colors.foregroundMuted,
      fontSize: 11,
      fontWeight: "700",
      letterSpacing: 0.35,
      textTransform: "uppercase",
    },
    currentActionText: {
      color: colors.foreground,
      fontSize: compact ? 13 : 15,
      lineHeight: compact ? 19 : 21,
      fontWeight: "500",
    },
    controlButton: {
      minHeight: compact ? 36 : 40,
      minWidth: compact ? 92 : 108,
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "center",
      gap: 7,
      borderRadius: 10,
      backgroundColor: colors.accent,
      paddingHorizontal: compact ? 12 : 16,
      paddingVertical: 8,
    },
    controlButtonDisabled: {
      opacity: 0.65,
    },
    controlButtonText: {
      color: colors.accentForeground,
      fontSize: compact ? 12 : 13,
      fontWeight: "700",
    },
    commandError: {
      color: colors.statusDanger,
      fontSize: 12,
      lineHeight: 17,
      paddingLeft: compact ? 38 : 46,
    },
  });
}
