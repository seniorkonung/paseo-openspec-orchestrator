import {
  type PluginWorkspacePanelProps,
  useWorkspace,
} from "@getpaseo/plugin/client";
import { ScrollView } from "@getpaseo/plugin/client/react-native";
import { useMemo } from "react";
import { StyleSheet, Text, View } from "react-native";

export function OrchestratorPanel({
  theme,
  layout,
  workspaceId,
}: PluginWorkspacePanelProps) {
  const workspace = useWorkspace(workspaceId, ({ directory, name, title }) => ({
    directory,
    name,
    title,
  }));
  const styles = useMemo(
    () =>
      StyleSheet.create({
        screen: {
          flex: 1,
          minHeight: 0,
          backgroundColor: theme.colors.surface0,
        },
        scroll: {
          flex: 1,
        },
        content: {
          flexGrow: 1,
          width: "100%",
          maxWidth: 960,
          alignSelf: "center",
          padding: layout.compact ? 16 : 24,
          gap: layout.compact ? 20 : 28,
        },
        header: {
          gap: layout.compact ? 6 : 8,
        },
        title: {
          color: theme.colors.foreground,
          fontSize: layout.compact ? 22 : 26,
          fontWeight: "600",
        },
        workspaceName: {
          color: theme.colors.foreground,
          fontSize: layout.compact ? 15 : 16,
          fontWeight: "500",
        },
        directory: {
          color: theme.colors.foregroundMuted,
          fontSize: layout.compact ? 12 : 13,
        },
        unavailable: {
          color: theme.colors.statusWarning,
          fontSize: layout.compact ? 13 : 14,
        },
        timeline: {
          flexGrow: 1,
          minHeight: layout.compact ? 160 : 240,
          alignItems: "center",
          justifyContent: "center",
          paddingVertical: layout.compact ? 24 : 40,
        },
        emptyState: {
          maxWidth: 480,
          alignItems: "center",
          gap: layout.compact ? 6 : 8,
        },
        emptyTitle: {
          color: theme.colors.foreground,
          fontSize: layout.compact ? 16 : 18,
          fontWeight: "500",
          textAlign: "center",
        },
        emptyDescription: {
          color: theme.colors.foregroundMuted,
          fontSize: layout.compact ? 13 : 14,
          lineHeight: layout.compact ? 19 : 21,
          textAlign: "center",
        },
        statusCard: {
          padding: layout.compact ? 14 : 16,
          gap: layout.compact ? 8 : 10,
          borderWidth: 1,
          borderColor: theme.colors.border,
          borderRadius: layout.compact ? 10 : 12,
          backgroundColor: theme.colors.surface1,
        },
        statusLabel: {
          color: theme.colors.foregroundMuted,
          fontSize: layout.compact ? 12 : 13,
          fontWeight: "500",
        },
        statusRow: {
          flexDirection: "row",
          alignItems: "center",
          gap: 8,
        },
        statusIndicator: {
          width: 8,
          height: 8,
          borderRadius: 4,
          backgroundColor: theme.colors.foregroundMuted,
        },
        statusValue: {
          color: theme.colors.foreground,
          fontSize: layout.compact ? 14 : 15,
          fontWeight: "600",
        },
        statusDescription: {
          color: theme.colors.foregroundMuted,
          fontSize: layout.compact ? 12 : 13,
          lineHeight: layout.compact ? 18 : 20,
        },
      }),
    [layout.compact, theme.colors],
  );

  const workspaceName = workspace?.title?.trim() || workspace?.name;

  return (
    <View style={styles.screen}>
      <ScrollView style={styles.scroll} contentContainerStyle={styles.content}>
        <View style={styles.header}>
          <Text style={styles.title}>Оркестратор OpenSpec</Text>
          {workspace ? (
            <>
              <Text style={styles.workspaceName}>{workspaceName}</Text>
              <Text selectable style={styles.directory}>
                {workspace.directory}
              </Text>
            </>
          ) : (
            <Text style={styles.unavailable}>Рабочая область недоступна.</Text>
          )}
        </View>

        <View style={styles.timeline}>
          <View style={styles.emptyState}>
            <Text style={styles.emptyTitle}>Событий пока нет</Text>
            <Text style={styles.emptyDescription}>
              События оркестратора появятся здесь после подключения серверной части.
            </Text>
          </View>
        </View>

        <View style={styles.statusCard}>
          <Text style={styles.statusLabel}>Текущее состояние</Text>
          <View style={styles.statusRow}>
            <View style={styles.statusIndicator} />
            <Text style={styles.statusValue}>Не подключён</Text>
          </View>
          <Text style={styles.statusDescription}>
            Управление оркестратором станет доступно после подключения серверной части.
          </Text>
        </View>
      </ScrollView>
    </View>
  );
}
