import openpyxl
from openpyxl.worksheet.datavalidation import DataValidation

wb = openpyxl.Workbook()
ws = wb.active
ws.title = 'Players'

# Headers
ws.append(['Name', 'Rating', 'Gender'])

# Sample data
ws.append(['John Doe', 2.0, 'Male'])
ws.append(['Jane Smith', 4.5, 'Female'])
ws.append(['Bob Johnson', 3.5, 'Unspecified'])

# Data validation for Rating (B2:B1000)
dv_rating = DataValidation(type='list', formula1='"2.0,2.5,3.0,3.5,4.0,4.5,5.0"', allow_blank=False)
ws.add_data_validation(dv_rating)
dv_rating.add('B2:B1000')

# Data validation for Gender (C2:C1000)
dv_gender = DataValidation(type='list', formula1='"Male,Female,Unspecified"', allow_blank=True)
ws.add_data_validation(dv_gender)
dv_gender.add('C2:C1000')

# Make columns a bit wider
ws.column_dimensions['A'].width = 25
ws.column_dimensions['B'].width = 12
ws.column_dimensions['C'].width = 15

wb.save('import-template.xlsx')
print('Done!')
