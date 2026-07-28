import { useMutation, useQueryClient, type DefaultError } from '@tanstack/react-query';
import { useToast } from '../components/ui/Toast';

interface ApiMutationOptions<TData> {
  successToast?: string | ((data: TData) => string);
  errorToast?: string | ((error: Error) => string);
  invalidateQueries?: string[];
}

export function useApiMutation<TVariables = void, TData = unknown>(
  mutationFn: (vars: TVariables) => Promise<TData>,
  opts?: ApiMutationOptions<TData>,
) {
  const qc = useQueryClient();
  const { toast } = useToast();

  return useMutation<TData, DefaultError, TVariables>({
    mutationFn,
    onSuccess: (data: TData) => {
      if (opts?.successToast) {
        const msg = typeof opts.successToast === 'function'
          ? opts.successToast(data)
          : opts.successToast;
        toast('success', msg);
      }
      if (opts?.invalidateQueries) {
        for (const key of opts.invalidateQueries) {
          qc.invalidateQueries({ queryKey: [key] });
        }
      }
    },
    onError: (err: DefaultError) => {
      if (opts?.errorToast) {
        const msg = typeof opts.errorToast === 'function'
          ? opts.errorToast(err)
          : opts.errorToast;
        toast('error', msg);
      } else {
        toast('error', err.message || 'An error occurred');
      }
    },
  });
}
