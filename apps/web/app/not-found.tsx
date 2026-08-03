import Link from 'next/link';
import type { ReactNode } from 'react';
import { Button, EmptyState } from '@naitikos/design-system';

import { DEFAULT_AUTHENTICATED_PATH } from '@/lib/auth/routes';

export const metadata = { title: 'Not found · NaitikOS' };

export default function NotFound(): ReactNode {
  return (
    <div className="app-shell__content">
      <EmptyState
        icon="status.warning"
        title="Not found"
        description="That page does not exist. It may be a module that has not been built yet."
      />
      <div style={{ display: 'flex', justifyContent: 'center' }}>
        <Button asChild variant="secondary">
          <Link href={DEFAULT_AUTHENTICATED_PATH}>Go to Today</Link>
        </Button>
      </div>
    </div>
  );
}
