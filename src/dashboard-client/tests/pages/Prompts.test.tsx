import { describe, it, expect, vi } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router';
import { Suspense } from 'react';
import { Prompts } from '../../src/pages/Prompts';

const {
  prompts,
  versions,
  listPromptsMock,
  createPromptMock,
  updatePromptMock,
  deletePromptMock,
  listPromptVersionsMock,
  enqueuePromptMock,
} = vi.hoisted(() => {
  const prompts = [
    {
      id: 'p1',
      name: 'api-builder',
      description: 'Build an Express REST API',
      created_at: '2026-01-01T00:00:00.000Z',
      updated_at: '2026-01-02T00:00:00.000Z',
      latest_version: 2,
      latest_tag: 'prod',
    },
  ];
  const versions = [
    {
      id: 'v2', prompt_id: 'p1', version: 2,
      system_prompt: 'You are an API builder', task: 'Build the API',
      config: null, tag: 'prod',
      created_at: '2026-01-02T00:00:00.000Z', created_by: 'admin',
    },
    {
      id: 'v1', prompt_id: 'p1', version: 1,
      system_prompt: 'You are an API builder', task: 'Build the API',
      config: null, tag: null,
      created_at: '2026-01-01T00:00:00.000Z', created_by: 'admin',
    },
  ];
  return {
    prompts,
    versions,
    listPromptsMock: vi.fn().mockResolvedValue(prompts),
    createPromptMock: vi.fn().mockResolvedValue({ id: 'p1', version: 1 }),
    updatePromptMock: vi.fn().mockResolvedValue({ ok: true }),
    deletePromptMock: vi.fn().mockResolvedValue({ ok: true }),
    listPromptVersionsMock: vi.fn().mockResolvedValue(versions),
    enqueuePromptMock: vi.fn().mockResolvedValue({ tasks: [], count: 0 }),
  };
});

vi.mock('../../src/lib/api', async () => {
  const actual = await vi.importActual('../../src/lib/api');
  return {
    ...actual,
    listPrompts: listPromptsMock,
    listScenarios: vi.fn().mockResolvedValue([{ name: 'express-rest' }]),
    listModels: vi.fn().mockResolvedValue([{ name: 'gpt-4o' }]),
    createPrompt: createPromptMock,
    updatePrompt: updatePromptMock,
    deletePrompt: deletePromptMock,
    listPromptVersions: listPromptVersionsMock,
    enqueuePrompt: enqueuePromptMock,
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

describe('Prompts', () => {
  it('renders the prompt list and a create form', async () => {
    renderWithProviders(<Prompts />);
    await waitFor(() => {
      expect(screen.getByText(/api-builder/)).toBeInTheDocument();
    });
    expect(screen.getByPlaceholderText(/prompt-name/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Create prompt/i })).toBeInTheDocument();
  });

  it('submitting the create form calls createPrompt with the form payload', async () => {
    renderWithProviders(<Prompts />);
    await waitFor(() => {
      expect(screen.getByPlaceholderText(/prompt-name/)).toBeInTheDocument();
    });

    fireEvent.change(screen.getByPlaceholderText(/prompt-name/), { target: { value: 'my-api' } });
    fireEvent.change(screen.getByPlaceholderText(/Description/), { target: { value: 'Test prompt' } });
    fireEvent.change(screen.getByPlaceholderText(/You are a helpful/), { target: { value: 'You are a builder' } });
    fireEvent.change(screen.getByPlaceholderText(/Implement the/), { target: { value: 'Build it' } });
    fireEvent.change(screen.getByPlaceholderText(/tag/), { target: { value: 'prod' } });
    fireEvent.click(screen.getByRole('button', { name: /Create prompt/i }));

    await waitFor(() => {
      expect(createPromptMock).toHaveBeenCalledWith({
        name: 'my-api',
        description: 'Test prompt',
        systemPrompt: 'You are a builder',
        task: 'Build it',
        tag: 'prod',
      });
    });
  });

  it('editing a prompt saves name and description via updatePrompt', async () => {
    renderWithProviders(<Prompts />);
    await waitFor(() => {
      expect(screen.getByText(/api-builder/)).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole('button', { name: /Edit/i }));
    fireEvent.change(screen.getByPlaceholderText(/Prompt name/), { target: { value: 'new-name' } });
    fireEvent.click(screen.getByRole('button', { name: /Save/i }));

    await waitFor(() => {
      expect(updatePromptMock).toHaveBeenCalledWith('p1', {
        name: 'new-name',
        description: 'Build an Express REST API',
      });
    });
  });

  it('deleting a prompt calls deletePrompt with its id', async () => {
    renderWithProviders(<Prompts />);
    await waitFor(() => {
      expect(screen.getByText(/api-builder/)).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole('button', { name: /Delete/i }));

    await waitFor(() => {
      expect(deletePromptMock).toHaveBeenCalledWith('p1');
    });
  });

  it('selecting a prompt shows its versions', async () => {
    renderWithProviders(<Prompts />);
    await waitFor(() => {
      expect(screen.getByText(/api-builder/)).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole('button', { name: /Versions/i }));

    await waitFor(() => {
      expect(listPromptVersionsMock).toHaveBeenCalledWith('p1');
      expect(screen.getByText(/You are an API builder/)).toBeInTheDocument();
      expect(screen.getByRole('option', { name: /v2/ })).toBeInTheDocument();
    });
  });

  it('enqueue submits model and scenario to enqueuePrompt', async () => {
    renderWithProviders(<Prompts />);
    await waitFor(() => {
      expect(screen.getByText(/api-builder/)).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole('button', { name: /Enqueue/i }));

    const comboboxes = await screen.findAllByRole('combobox');
    fireEvent.change(comboboxes[0]!, { target: { value: 'express-rest' } });
    fireEvent.change(screen.getByPlaceholderText(/gpt-4o/), { target: { value: 'gpt-4o' } });
    fireEvent.click(screen.getByRole('button', { name: /Queue run/i }));

    await waitFor(() => {
      expect(enqueuePromptMock).toHaveBeenCalledWith({
        promptId: 'p1',
        promptVersion: 2,
        models: ['gpt-4o'],
        scenario: 'express-rest',
      });
    });
  });
});
