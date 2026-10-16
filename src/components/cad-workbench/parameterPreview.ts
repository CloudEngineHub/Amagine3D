import type { ParameterModel } from '../../types';

export function editableParameterPreviewPath(
  models: readonly ParameterModel[],
  designPath: string,
  previousRevision?: string,
): string | undefined {
  return models.find((model) => model.editable && model.designPath === designPath &&
    (!previousRevision || model.revision !== previousRevision))?.displayPreviewPath;
}
