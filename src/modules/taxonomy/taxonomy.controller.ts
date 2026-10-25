import { Controller, Get } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { TaxonomyResponseDto } from './dto/taxonomy.dto';
import { TaxonomyService } from './taxonomy.service';

@ApiTags('taxonomy')
@Controller('taxonomy')
export class TaxonomyController {
  constructor(private readonly taxonomy: TaxonomyService) {}

  @Get()
  @ApiOperation({
    summary: 'Discovery categories and subcategories',
    description:
      'The shared campaign/idea taxonomy in display order, with a live count of public ideas per term. ' +
      'Counts follow the same visibility rule as GET /ideas and are derived, never stored.',
  })
  @ApiOkResponse({ type: TaxonomyResponseDto })
  tree() {
    return this.taxonomy.tree();
  }
}
