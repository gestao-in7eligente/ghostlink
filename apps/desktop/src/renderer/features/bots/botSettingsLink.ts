// "Abrir" on the company Hermes's page (spec 2026-10-03-pagina-do-hermes-da-empresa-design.md §2): the
// bot's settings open at one tab. BOTS in the sidebar (BotsSection) owns the settings dialog and takes it.
import { create } from 'zustand';

export const useBotSettingsLink = create<{ wanted: { botId: string; tab: string } | null }>()(() => ({ wanted: null }));

export function openBotSettings(botId: string, tab: string): void {
  useBotSettingsLink.setState({ wanted: { botId, tab } });
}
