import React, { useState } from 'react';
import { Alert, FlatList, View } from 'react-native';
import { router } from 'expo-router';
import * as DocumentPicker from 'expo-document-picker';
import { File } from 'expo-file-system';
import { api, ApiError } from '../../../../src/api/client';
import type { GroupSummary } from '../../../../src/api/types';
import { useI18n } from '../../../../src/i18n';
import { useSession } from '../../../../src/state/session';
import { useAsync } from '../../../../src/ui/useAsync';
import { Avatar, Button, Field, Muted, Row, Screen, Title } from '../../../../src/ui/kit';

/** All contexts in the org (admins see every group), manual creation and CSV import (§4.2.1). */
export default function Contexts() {
  const { t } = useI18n();
  const { org } = useSession();
  const [q, setQ] = useState('');
  const { data, reload } = useAsync(() => api.get<{ groups: GroupSummary[] }>(`/v1/groups?scope=all&limit=200${q ? `&q=${encodeURIComponent(q)}` : ''}`), [q]);
  const [busy, setBusy] = useState(false);
  const label = org?.contextType?.label ?? '';
  const locked = org?.mode === 'connected';

  const importCsv = async () => {
    const r = await DocumentPicker.getDocumentAsync({ type: ['text/csv', 'text/comma-separated-values', 'application/vnd.ms-excel', 'text/plain'], copyToCacheDirectory: true });
    if (r.canceled) return;
    setBusy(true);
    try {
      const text = await new File(r.assets[0].uri).text();
      const res = await api.post<{ created: number; errors: { row: number; error: string }[] }>('/v1/admin/contexts/import', undefined, { raw: text, headers: { 'content-type': 'text/csv' } });
      Alert.alert(t('importCsv'), t('importResult', { n: res.created, e: res.errors.length }) + (res.errors.length ? '\n' + res.errors.slice(0, 10).map((e) => `#${e.row}: ${e.error}`).join('\n') : ''));
      await reload();
    } catch (e) {
      Alert.alert(t('error'), (e as ApiError).code);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Screen>
      <View style={{ padding: 16, gap: 10 }}>
        <Title sub={locked ? t('managedBy', { name: org?.org.name ?? '' }) : 'CSV: name, display_id, external_id, <header keys>, members (phones separated by ;)'}>{t('contexts')}</Title>
        <Field value={q} onChangeText={setQ} placeholder={t('searchGroups')} />
        {!locked ? (
          <View style={{ flexDirection: 'row', gap: 8 }}>
            <Button style={{ flex: 1 }} title={`＋ ${t('newContext', { label })}`} onPress={() => router.push('/(main)/new-context')} />
            <Button style={{ flex: 1 }} variant="secondary" title={t('importCsv')} onPress={importCsv} loading={busy} />
          </View>
        ) : null}
      </View>
      <FlatList
        data={data?.groups ?? []}
        keyExtractor={(g) => g.id}
        ListEmptyComponent={<Muted style={{ textAlign: 'center' }}>{t('noGroups')}</Muted>}
        renderItem={({ item: g }) => (
          <Row title={`${g.name} ${g.displayId}`} subtitle={g.archivedAt ? t('archivedGroup') : undefined} left={<Avatar name={g.name} size={36} />}
            onPress={() => router.push({ pathname: '/(main)/group/info/[id]', params: { id: g.id } })} />
        )}
      />
    </Screen>
  );
}
