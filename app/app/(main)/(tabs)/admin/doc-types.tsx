import React, { useState } from 'react';
import { Alert, Switch } from 'react-native';
import { api } from '../../../../src/api/client';
import { useI18n } from '../../../../src/i18n';
import { useSession } from '../../../../src/state/session';
import { useAsync } from '../../../../src/ui/useAsync';
import { Button, Divider, Field, Row, Screen, Section, Title } from '../../../../src/ui/kit';

export default function DocTypes() {
  const { t } = useI18n();
  const { refreshOrg } = useSession();
  const { data, reload } = useAsync(() => api.get<{ docTypes: { id: string; name: string; active: number; sort: number }[] }>('/v1/admin/doc-types'), []);
  const [name, setName] = useState('');
  const after = async () => {
    await reload();
    await refreshOrg();
  };
  return (
    <Screen scroll>
      <Title>{t('docTypes')}</Title>
      <Section>
        {(data?.docTypes ?? []).map((d, i) => (
          <React.Fragment key={d.id}>
            {i ? <Divider /> : null}
            <Row
              title={d.name}
              onPress={() => Alert.prompt?.(t('name'), undefined, async (v) => { if (v?.trim()) { await api.patch(`/v1/admin/doc-types/${d.id}`, { name: v.trim() }); await after(); } }, 'plain-text', d.name)}
              right={<Switch value={!!d.active} onValueChange={async (v) => { await api.patch(`/v1/admin/doc-types/${d.id}`, { active: v }); await after(); }} />}
            />
          </React.Fragment>
        ))}
      </Section>
      <Field placeholder={t('name')} value={name} onChangeText={setName} />
      <Button title={`＋ ${t('docType')}`} disabled={!name.trim()} onPress={async () => { await api.post('/v1/admin/doc-types', { name, sort: data?.docTypes.length ?? 0 }); setName(''); await after(); }} />
    </Screen>
  );
}
