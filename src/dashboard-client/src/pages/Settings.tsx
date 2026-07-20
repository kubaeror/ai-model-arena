import { useState } from 'react';
import { Panel, PanelHeader, PanelBody } from '../components/ui/Panel';
import { Tabs } from '../components/ui/Tabs';
import { Button } from '../components/ui/Button';
import { useSettings } from '../providers/SettingsProvider';

export function Settings() {
  const [tab, setTab] = useState('general');
  const { theme, setTheme } = useSettings();

  return (
    <div className="flex flex-col gap-16">
      <h1 className="font-display text-28 font-600">Settings</h1>
      <Tabs
        items={[
          { id: 'general', label: 'General' },
          { id: 'auth', label: 'Auth' },
          { id: 'scenarios', label: 'Scenarios' },
          { id: 'providers', label: 'Providers' },
          { id: 'notifications', label: 'Notifications' },
        ]}
        value={tab}
        onChange={setTab}
      />

      {tab === 'general' && (
        <Panel>
          <PanelHeader title="Theme" />
          <PanelBody>
            <div className="flex gap-8">
              {(['auto', 'dark', 'light'] as const).map(t => (
                <Button key={t} variant={theme === t ? 'primary' : 'ghost'} onClick={() => setTheme(t)}>
                  {t}
                </Button>
              ))}
            </div>
          </PanelBody>
        </Panel>
      )}

      {tab === 'auth' && (
        <Panel><PanelHeader title="Authentication" /><PanelBody><p className="font-body text-14 text-fg-1">JWT and API key management — see server configuration.</p></PanelBody></Panel>
      )}
      {tab === 'scenarios' && (
        <Panel><PanelHeader title="Scenarios" /><PanelBody><p className="font-body text-14 text-fg-1">Scenario CRUD — embed ScenarioForm here (moved from /scenarios).</p></PanelBody></Panel>
      )}
      {tab === 'providers' && (
        <Panel><PanelHeader title="Providers" /><PanelBody><p className="font-body text-14 text-fg-1">Custom provider CRUD — mirror of Ops providers table.</p></PanelBody></Panel>
      )}
      {tab === 'notifications' && (
        <Panel><PanelHeader title="Notifications" /><PanelBody><p className="font-body text-14 text-fg-1">Webhook management — existing webhooks CRUD.</p></PanelBody></Panel>
      )}
    </div>
  );
}
