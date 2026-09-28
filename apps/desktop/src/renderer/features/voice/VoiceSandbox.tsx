import { ChevronDown, House, LogOut, Settings, Volume2, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import type { RendererWelcome } from '../../../shared/ipcTypes.js';
import { useT } from '../../i18n/index.js';
import { VoiceAvatar } from './parts.js';
import { joinVoice, useVoiceDirectory, useVoiceRuntime } from './runtime.js';
import { useVoiceStore } from './state.js';
import { VoiceChannelParticipants } from './VoiceChannelParticipants.js';
import { VoiceControls } from './VoiceControls.js';
import { VoicePanel } from './VoicePanel.js';
import { VoiceSettings } from './VoiceSettings.js';
import { VoiceStage } from './VoiceStage.js';
import v from './voice.module.css';
import s from './sandbox.module.css';

/**
 * PROVISIONAL (voice track only): a reference-style host for the voice components until
 * the Text track's main layout lands; integration replaces it with the layout's slots
 * (VoiceChannelParticipants under voice channels, VoicePanel + VoiceControls in the user
 * panel, VoiceStage in the center, joinVoice as onJoinVoice, VoiceSettings in settings).
 */
export function VoiceSandbox({ welcome, onLeave }: { welcome: RendererWelcome; onLeave(): void }) {
  useVoiceRuntime();
  const t = useT();
  const directory = useVoiceDirectory();
  const channels = directory.voiceChannels();
  const inChannel = useVoiceStore((st) => st.call.channelId);
  const [selected, setSelected] = useState<string | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const shown = selected ?? inChannel ?? channels[0]?.id ?? null;

  // Follow the call when it moves (a moderator's move, or joining from elsewhere).
  useEffect(() => {
    if (inChannel) setSelected(inChannel);
  }, [inChannel]);

  useEffect(() => {
    if (!settingsOpen) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setSettingsOpen(false);
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [settingsOpen]);

  const leaveServer = async () => {
    await window.ghostlink.servers.disconnect();
    onLeave();
  };
  const initial = (welcome.server.name.trim()[0] ?? '?').toUpperCase();

  return (
    <div className={s.shell}>
      <nav className={s.rail} aria-label={welcome.server.name}>
        <span className={s.railButton} aria-hidden="true">
          <House size={20} />
        </span>
        <span className={s.railDivider} aria-hidden="true" />
        <span className={`${s.railButton} ${s.railServer}`} title={welcome.server.name}>
          {initial}
        </span>
      </nav>

      <aside className={s.sidebar}>
        <header className={s.header}>
          <span className={s.headerMark} aria-hidden="true">
            {initial}
          </span>
          <strong>{welcome.server.name}</strong>
          <ChevronDown size={18} className={s.headerChevron} aria-hidden="true" />
        </header>
        <div className={s.channels}>
          <h3 className={s.sectionTitle}>{t('voice.sandbox.voiceChannels')}</h3>
          {channels.length === 0 && <p className={s.empty}>{t('voice.sandbox.noChannels')}</p>}
          {channels.map((c) => (
            <div key={c.id}>
              <button
                type="button"
                className={s.channelRow}
                aria-current={shown === c.id}
                data-voice-channel={c.id}
                onClick={() => {
                  setSelected(c.id);
                  void joinVoice(c.id);
                }}
              >
                <Volume2 size={18} className={s.channelIcon} aria-hidden="true" />
                {c.name}
              </button>
              <VoiceChannelParticipants channelId={c.id} />
            </div>
          ))}
        </div>
      </aside>

      <div className={s.dock}>
        <div className={s.card}>
          <VoicePanel />
          <div className={s.userRow}>
            <span className={s.me}>
              <VoiceAvatar size={32} />
              <span className={s.onlineDot} aria-hidden="true" />
            </span>
            <span className={s.userText}>
              <strong>{welcome.self.nickname}</strong>
              <span>{t('voice.sandbox.status')}</span>
            </span>
            <VoiceControls onOpenSettings={() => setSettingsOpen(true)} />
            <button type="button" className={v.iconButton} aria-label={t('voice.openSettings')} title={t('voice.openSettings')} onClick={() => setSettingsOpen(true)}>
              <Settings size={18} aria-hidden="true" />
            </button>
            <button type="button" className={`${v.iconButton} ${s.exit}`} aria-label={t('voice.sandbox.leaveServer')} title={t('voice.sandbox.leaveServer')} onClick={() => void leaveServer()}>
              <LogOut size={18} aria-hidden="true" />
            </button>
          </div>
        </div>
      </div>

      <main className={s.center}>{shown ? <VoiceStage channelId={shown} /> : <div className={s.placeholder}>{t('voice.sandbox.noChannels')}</div>}</main>

      {settingsOpen && (
        <div className={s.overlay} onPointerDown={(e) => e.target === e.currentTarget && setSettingsOpen(false)}>
          <div className={s.dialog} role="dialog" aria-modal="true" aria-label={t('voice.openSettings')}>
            <button type="button" className={`${v.iconButton} ${s.dialogClose}`} aria-label={t('voice.sandbox.close')} onClick={() => setSettingsOpen(false)}>
              <X size={18} aria-hidden="true" />
            </button>
            <VoiceSettings />
          </div>
        </div>
      )}
    </div>
  );
}
