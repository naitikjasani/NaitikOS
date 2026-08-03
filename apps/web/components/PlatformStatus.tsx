'use client';

import type { ReactNode } from 'react';
import {
  Badge,
  Button,
  Card,
  CardBody,
  CardHeader,
  ChartFrame,
  EmptyState,
  Grid,
  Inline,
  Progress,
  Stack,
  Text,
  useToast,
} from '@naitikos/design-system';

import { useSession } from '@/features/auth';
import { useNavigationStore } from '@/lib/stores/navigation.store';

/**
 * Platform status — the shell demonstrating itself.
 *
 * Exists so the component library and the shell are observable end to end
 * without building a feature. Every value here is static: nothing reads the
 * database, nothing computes a health metric, and there is no dashboard widget
 * in the sense the milestone forbids.
 *
 * It doubles as the manual accessibility surface: tab through it and every
 * control, overlay, and toast in the library is reachable.
 */
export function PlatformStatus(): ReactNode {
  const { session } = useSession();
  const { toast } = useToast();
  const setSettingsOpen = useNavigationStore((state) => state.setSettingsOpen);
  const setCommandPaletteOpen = useNavigationStore((state) => state.setCommandPaletteOpen);

  return (
    <Stack gap="6">
      <Grid minColumnWidth="18rem" gap="4">
        <Card variant="outlined">
          <CardHeader title="Session" description="Resolved on the server, per request." />
          <CardBody>
            <Stack gap="2">
              <Inline gap="2" justify="between">
                <Text role="body-sm" tone="secondary">
                  Account
                </Text>
                <Text role="body-sm">{session?.email ?? '—'}</Text>
              </Inline>
              <Inline gap="2" justify="between">
                <Text role="body-sm" tone="secondary">
                  Role
                </Text>
                <Badge tone="accent">{session?.role ?? '—'}</Badge>
              </Inline>
            </Stack>
          </CardBody>
        </Card>

        <Card variant="outlined">
          <CardHeader title="Platform" description="What the foundation currently provides." />
          <CardBody>
            <Stack gap="3">
              <Progress value={100} label="Design tokens" showValue />
              <Progress value={100} label="Component library" showValue />
              <Progress value={100} label="Application shell" showValue />
              {/*
                Neutral, not "red for incomplete".
                §8.2: colour never encodes valence. An unbuilt module is a fact,
                not a failure, and colouring it as one would be the exact
                dynamic P6 rules out.
              */}
              <Progress value={0} label="Feature modules" showValue />
            </Stack>
          </CardBody>
        </Card>
      </Grid>

      <Card variant="outlined">
        <CardHeader
          title="Component library"
          description="Overlays, toasts, and the palette — reachable by keyboard."
        />
        <CardBody>
          <Inline gap="2">
            <Button
              variant="primary"
              iconStart="action.search"
              onClick={() => {
                setCommandPaletteOpen(true);
              }}
            >
              Command palette
            </Button>
            <Button
              variant="secondary"
              iconStart="nav.settings"
              onClick={() => {
                setSettingsOpen(true);
              }}
            >
              Settings
            </Button>
            <Button
              variant="secondary"
              onClick={() => {
                // Demonstrates the undo affordance §8.12 makes the primary
                // protection for destructive actions.
                toast({
                  title: 'Nothing was deleted',
                  description: 'This is the undo pattern destructive actions use.',
                  action: {
                    label: 'Undo',
                    onAction: () => {
                      toast({ title: 'Undone', tone: 'positive' });
                    },
                  },
                });
              }}
            >
              Show a toast
            </Button>
          </Inline>
        </CardBody>
      </Card>

      {/*
        The chart frame with no plot layer.
        §8.9's frame guarantees — the table toggle, the legend, the truncation
        notice — are all present and testable before a charting library exists.
      */}
      <Card variant="outlined">
        <CardBody>
          <ChartFrame
            form="trend"
            title="Chart architecture"
            description="The frame, the legend, and the mandatory data table. The plot layer is V2."
            height={180}
            data={{
              yAxis: { label: 'Example', unit: '', zeroBaseline: true },
              series: [
                {
                  id: 'a',
                  label: 'Series A',
                  slot: 1,
                  points: [
                    { at: '2026-08-01', value: 3 },
                    // A gap, rendered as a gap — §8.9(3) forbids interpolation.
                    { at: '2026-08-02', value: null },
                    { at: '2026-08-03', value: 4 },
                  ],
                },
                {
                  id: 'b',
                  label: 'Series B',
                  slot: 2,
                  points: [
                    { at: '2026-08-01', value: 1 },
                    { at: '2026-08-02', value: 2 },
                    { at: '2026-08-03', value: 2 },
                  ],
                },
              ],
              annotations: [
                { id: 'x', at: '2026-08-02', label: 'Example intervention marker', kind: 'point' },
              ],
            }}
          />
        </CardBody>
      </Card>

      <Card variant="outlined">
        <CardBody>
          <EmptyState
            icon="nav.today"
            title="No modules yet"
            description="The Daily Close, Gym, Mind, and Skin arrive from Week 2. Empty states are a designed surface, not a blank rectangle."
          />
        </CardBody>
      </Card>
    </Stack>
  );
}
