import { Pipe, PipeTransform } from '@angular/core';

@Pipe({
  name: 'formatCost'
})
export class FormatCostPipe implements PipeTransform {

  transform(value: number | null | undefined): string {
    if (value === null || value === undefined) {
      return 'N/A';
    }
    let formattedString: string;
    if (Math.abs(value) < 0.00001 && value !== 0) {
      formattedString = value.toFixed(9);
    } else {
      formattedString = value.toFixed(8); // Use toFixed(8) as instructed
    }

    // Add Cleanup Logic
    if (formattedString.includes('.')) {
      return formattedString.replace(/\.?0+$/, '');
    } else {
      return formattedString;
    }
  }

}
