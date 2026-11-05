import React, { useState } from 'react';
import { router } from 'expo-router';
import { api, ApiError } from '../../src/api/client';
import { useI18n } from '../../src/i18n';
import { useSession } from '../../src/state/session';
import { Avatar, Button, Divider, ErrorText, Field, Row, Screen, Section, Title } from '../../src/ui/kit';

/** Manual context creation (§4.2.1): name + identifier + header fields; creates the context's group. */
export default function NewContext() {
  const { t } = useI18n();
  const { org, members, engine } = useSession();
  const [name, setName] = useState('');
  const [displayId, setDisplayId] = useState('');
  const [header, setHeader] = useState<Record<string, string>>({});
  const [selected, setSelected] = useState<string[]>(engine ? [engine.userId] : []);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const label = org?.contextType?.label ?? '';

  const create = async () => {
    setBusy(true);
    try {
      const r = await api.post<{ groupId: string }>('/v1/contexts', { name, displayId, header, memberIds: selected });
      await engine?.refreshGroups();
      router.replace({ pathname: '/(main)/group/[id]', params: { id: r.groupId } });
    } catch (e) {
      setError((e as ApiError).code);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Screen scroll>
      <Title>{t('newContext', { label })}</Title>
      <Field label={t('name')} value={name} onChangeText={setName} />
      <Field label={t('identifier')} value={displayId} onChangeText={setDisplayId} />
      {org?.contextType?.headerFields.map((f) => (
        <Field key={f.key} label={f.label} value={header[f.key] ?? ''} onChangeText={(v) => setHeader((h) => ({ ...h, [f.key]: v }))} />
      ))}
      <Section title={t('members')}>
        {members.map((m, i) => (
          <React.Fragment key={m.id}>
            {i ? <Divider /> : null}
            <Row title={m.name} subtitle={m.jobTitle} left={<Avatar name={m.name} size={34} />} right={selected.includes(m.id) ? <Title>✓</Title> : null}
              onPress={() => setSelected((cur) => (cur.includes(m.id) ? cur.filter((x) => x !== m.id) : [...cur, m.id]))} />
          </React.Fragment>
        ))}
      </Section>
      <ErrorText>{error}</ErrorText>
      <Button title={t('save')} onPress={create} loading={busy} disabled={!name.trim()} />
      <Button variant="ghost" title={t('cancel')} onPress={() => router.back()} />
    </Screen>
  );
}
