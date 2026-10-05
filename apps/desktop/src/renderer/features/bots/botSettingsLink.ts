// Opens a bot's settings at one tab from elsewhere in the app. BOTS in the sidebar (BotsSection) owns the
// settings dialog and takes the request.
import { create } from 'zustand';

export const useBotSettingsLink = create<{ wanted: { botId: string; tab: string } | null }>()(() => ({ wanted: null }));

export function openBotSettings(botId: string, tab: string): void {
  useBotSettingsLink.setState({ wanted: { botId, tab } });
}
