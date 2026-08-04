import { Link } from 'react-router';
import { PageShell } from '../components/ui/PageShell';
import { Button } from '../components/ui/Button';

export function NotFound() {
  return (
    <PageShell
      title="Page not found"
      description="The page you're looking for doesn't exist or has been moved."
      actions={
        <Link to="/">
          <Button variant="primary">Back to Home</Button>
        </Link>
      }
    >
      <div className="flex items-center justify-center py-16">
        <span className="font-display text-72 font-700 text-accent select-none">404</span>
      </div>
    </PageShell>
  );
}
