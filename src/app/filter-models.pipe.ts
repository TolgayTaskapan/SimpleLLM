import { Pipe, PipeTransform } from '@angular/core';
import { Model } from './app.component'; // Assuming Model interface is exported from app.component.ts

@Pipe({
  name: 'filterModels'
})
export class FilterModelsPipe implements PipeTransform {

  transform(models: Model[] | null | undefined, filterString: string): Model[] {
    if (!models) {
      return [];
    }

    if (!filterString) {
      return models;
    }

    const lowerCaseFilter = filterString.toLowerCase();

    return models.filter(model =>
      model.name.toLowerCase().includes(lowerCaseFilter)
    );
  }

}
