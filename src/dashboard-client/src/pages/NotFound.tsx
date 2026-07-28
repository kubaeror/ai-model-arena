import { Link } from 'react-router-dom';
import { EmptyState } from '../components/ui/EmptyState';
import { Button } from '../components/ui/Button';

export function NotFound() {
  return (
    <div className="flex items-center justify-center min-h-[60vh]">
      <div className="text-center">
        <h1 className="font-display text-72 font-700 text-accent mb-2">404</h1>
        <EmptyState
          title="Page not found"
          description="The page you're looking for doesn't exist or has been moved."
          action={
            <Link to="/">
              <Button>Back to Home</Button>
            </Link>
          }
        />
      </div>
    </div>
  );
}
