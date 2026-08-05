import { describe, it, expect, vi } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router';
import { Suspense } from 'react';
import { OutputMappings } from '../../src/pages/OutputMappings';

const { mappings, listOutputMappingsMock, createOutputMappingMock, updateOutputMappingMock, deleteOutputMappingMock } =
  vi.hoisted(() => {
    const mappings = [
      {
        id: 'm1',
        scope: 'global',
        scope_id: 'run-123',
        parent_folder: '/outputs/shared',
        per_model_pattern: '{model}/results',
        created_at: '2026-01-01T00:00:00.000Z',
        updated_at: '2026-01-02T00:00:00.000Z',
      },
    ];
    return {
      mappings,
      listOutputMappingsMock: vi.fn().mockResolvedValue(mappings),
      createOutputMappingMock: vi.fn().mockResolvedValue({ ok: true }),
      updateOutputMappingMock: vi.fn().mockResolvedValue({ ok: true }),
      deleteOutputMappingMock: vi.fn().mockResolvedValue({ ok: true }),
    };
  });

vi.mock('../../src/lib/api', async () => {
  const actual = await vi.importActual('../../src/lib/api');
  return {
    ...actual,
    listOutputMappings: listOutputMappingsMock,
    createOutputMapping: createOutputMappingMock,
    updateOutputMapping: updateOutputMappingMock,
    deleteOutputMapping: deleteOutputMappingMock,
  };
});

function renderWithProviders(ui: React.ReactElement) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <Suspense fallback={<div>Loading...</div>}>{ui}</Suspense>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('OutputMappings', () => {
  it('renders existing mappings in the table', async () => {
    renderWithProviders(<OutputMappings />);
    await waitFor(() => {
      expect(screen.getByText(/global/)).toBeInTheDocument();
      expect(screen.getByText(/run-123/)).toBeInTheDocument();
      expect(screen.getByText(/\/outputs\/shared/)).toBeInTheDocument();
      expect(screen.getByText(/\{model\}\/results/)).toBeInTheDocument();
    });
  });

  it('submitting the create form calls createOutputMapping with the form payload', async () => {
    renderWithProviders(<OutputMappings />);
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /New mapping/i })).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole('button', { name: /New mapping/i }));
    fireEvent.change(screen.getByRole('combobox', { name: 'Scope' }), { target: { value: 'model' } });
    fireEvent.change(screen.getByPlaceholderText(/gpt-4o|run-id/i), { target: { value: 'gpt-4o' } });
    fireEvent.change(screen.getByPlaceholderText(/parent folder/i), { target: { value: '/outputs/arena' } });
    fireEvent.change(screen.getByPlaceholderText(/per-model pattern/i), { target: { value: '{model}/{runId}' } });
    fireEvent.click(screen.getByRole('button', { name: /Create mapping/i }));

    await waitFor(() => {
      expect(createOutputMappingMock).toHaveBeenCalledWith({
        scope: 'model',
        scopeId: 'gpt-4o',
        parentFolder: '/outputs/arena',
        perModelPattern: '{model}/{runId}',
      });
    });
  });

  it('editing a mapping saves the updated pattern via updateOutputMapping', async () => {
    renderWithProviders(<OutputMappings />);
    await waitFor(() => {
      expect(screen.getByText(/run-123/)).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole('button', { name: /Edit/i }));
    fireEvent.change(screen.getByPlaceholderText(/parent folder/i), { target: { value: '/outputs/new' } });
    fireEvent.click(screen.getByRole('button', { name: /Save/i }));

    await waitFor(() => {
      expect(updateOutputMappingMock).toHaveBeenCalledWith('m1', {
        scope: 'global',
        scopeId: 'run-123',
        parentFolder: '/outputs/new',
        perModelPattern: '{model}/results',
      });
    });
  });

  it('deleting a mapping asks for confirmation then calls deleteOutputMapping', async () => {
    renderWithProviders(<OutputMappings />);
    await waitFor(() => {
      expect(screen.getByText(/run-123/)).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole('button', { name: /Delete/i }));
    fireEvent.click(screen.getByRole('button', { name: /Confirm delete/i }));

    await waitFor(() => {
      expect(deleteOutputMappingMock).toHaveBeenCalledWith('m1');
    });
  });
});
